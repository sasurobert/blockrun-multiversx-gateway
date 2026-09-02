"""
BlockRun MultiversX Autonomous AI Agent Client SDK for Python.
"""

import base64
import json
import urllib.request
import urllib.error
from typing import Any, Dict, Generator, List, Optional, Union

from .errors import APIError, PaymentError, SpendLimitError
from .signer import UserSigner


def _build_esdt_transfer_data(asset: str, amount_str: str) -> str:
    """Encodes ESDTTransfer payload in MultiversX format: ESDTTransfer@<token_hex>@<amount_hex>"""
    token_hex = asset.encode("utf-8").hex()
    amount_int = int(amount_str)
    amount_hex = hex(amount_int)[2:]
    if len(amount_hex) % 2 != 0:
        amount_hex = "0" + amount_hex
    return f"ESDTTransfer@{token_hex}@{amount_hex}"


class BlockRunMvxClient:
    """Client for executing AI model completions with autonomous MultiversX x402 payments."""

    def __init__(
        self,
        signer: Optional[UserSigner] = None,
        gateway_url: str = "http://localhost:3000",
        network: str = "multiversx:1",
        relayer_address: Optional[str] = None,
        max_cost_per_call: Optional[float] = None,
        max_session_cost: Optional[float] = None,
        timeout: float = 30.0,
    ):
        self.signer = signer or UserSigner.generate()
        self.gateway_url = gateway_url.rstrip("/")
        self.network = network
        self.relayer_address = relayer_address
        self.max_cost_per_call = max_cost_per_call
        self.max_session_cost = max_session_cost
        self.timeout = timeout

        self.session_spend_usd = 0.0
        self.local_nonce = 0
        self.chain_id = "1" if network == "multiversx:1" else "D"

    def get_wallet_address(self) -> str:
        """Returns the agent's bech32 address."""
        return self.signer.address

    def get_session_spend(self) -> float:
        """Returns cumulative spend in USD for this session."""
        return self.session_spend_usd

    def resolve_relayer_address(self) -> str:
        """Resolves relayer address for the agent's shard from gateway."""
        if self.relayer_address:
            return self.relayer_address

        try:
            url = f"{self.gateway_url}/relayer/address/{self.signer.address}"
            req = urllib.request.Request(url, headers={"User-Agent": "BlockRun-Mvx-Python/1.0"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if "relayerAddress" in data:
                    self.relayer_address = data["relayerAddress"]
                    return self.relayer_address
        except Exception:
            pass

        return self.signer.address

    def _execute_with_402_loop(
        self, endpoint: str, body: Dict[str, Any], extra_headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """Executes HTTP request with automated 402 payment negotiation."""
        url = f"{self.gateway_url}{endpoint}"
        payload_bytes = json.dumps(body).encode("utf-8")

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "BlockRun-Mvx-Python/1.0",
        }
        if extra_headers:
            headers.update(extra_headers)

        req = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                receipt = resp.headers.get("x-payment-receipt") or resp.headers.get("X-Payment-Receipt")
                if receipt:
                    data["paymentReceipt"] = receipt
                return data
        except urllib.error.HTTPError as e:
            if e.code != 402:
                err_content = e.read().decode("utf-8")
                try:
                    err_json = json.loads(err_content)
                    msg = err_json.get("error", err_content)
                except Exception:
                    msg = err_content
                raise APIError(msg, e.code)

            # Handle 402 challenge
            challenge_header = e.headers.get("PAYMENT-REQUIRED") or e.headers.get("payment-required")
            challenge_body = None

            if challenge_header:
                try:
                    challenge_body = json.loads(base64.b64decode(challenge_header).decode("utf-8"))
                except Exception:
                    pass

            if not challenge_body:
                raw_body = e.read().decode("utf-8")
                try:
                    challenge_body = json.loads(raw_body)
                except Exception:
                    raise PaymentError("Received HTTP 402 but could not parse payment requirements")

            accepts = challenge_body.get("accepts", [])
            if not accepts:
                raise PaymentError("HTTP 402 response contained empty accepts requirements")

            requirements = accepts[0]
            amount_str = requirements["amount"]
            asset = requirements["asset"]
            pay_to = requirements["payTo"]
            decimals = requirements.get("extra", {}).get("decimals", 6)

            cost_usd = int(amount_str) / (10 ** decimals)

            # Spend limits enforcement
            if self.max_cost_per_call is not None and cost_usd > self.max_cost_per_call:
                raise SpendLimitError(
                    f"Requested call cost (${cost_usd:.6f}) exceeds max_cost_per_call (${self.max_cost_per_call:.6f})",
                    "call",
                    cost_usd,
                    self.max_cost_per_call,
                )

            if self.max_session_cost is not None and (self.session_spend_usd + cost_usd) > self.max_session_cost:
                raise SpendLimitError(
                    f"Projected session spend (${self.session_spend_usd + cost_usd:.6f}) would exceed max_session_cost (${self.max_session_cost:.6f})",
                    "session",
                    self.session_spend_usd + cost_usd,
                    self.max_session_cost,
                )

            relayer = self.resolve_relayer_address()
            nonce = self.local_nonce
            self.local_nonce += 1

            transfer_data = _build_esdt_transfer_data(asset, amount_str)
            data_b64 = base64.b64encode(transfer_data.encode("utf-8")).decode("ascii")

            # MultiversX signing payload
            tx_dict = {
                "nonce": nonce,
                "value": "0",
                "receiver": pay_to,
                "sender": self.signer.address,
                "gasPrice": 1000000000,
                "gasLimit": 500000,
                "data": data_b64,
                "chainID": self.chain_id,
                "version": 2,
                "options": 0,
                "relayer": relayer,
            }

            signing_bytes = json.dumps(tx_dict, sort_keys=True, separators=(",", ":")).encode("utf-8")
            signature_hex = self.signer.sign(signing_bytes).hex()

            x402_payload = {
                "x402Version": 2,
                "resource": {"url": url, "description": "AI Model Inference Payment"},
                "accepted": requirements,
                "payload": {
                    "nonce": nonce,
                    "value": "0",
                    "receiver": pay_to,
                    "sender": self.signer.address,
                    "gasPrice": 1000000000,
                    "gasLimit": 500000,
                    "data": transfer_data,
                    "chainID": self.chain_id,
                    "version": 2,
                    "options": 0,
                    "signature": signature_hex,
                    "relayer": relayer,
                },
            }

            encoded_sig_header = base64.b64encode(json.dumps(x402_payload).encode("utf-8")).decode("ascii")
            headers["PAYMENT-SIGNATURE"] = encoded_sig_header

            # Retry request with payment header
            retry_req = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(retry_req, timeout=self.timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    receipt = resp.headers.get("x-payment-receipt") or resp.headers.get("X-Payment-Receipt")
                    if receipt:
                        data["paymentReceipt"] = receipt
                    self.session_spend_usd += cost_usd
                    return data
            except urllib.error.HTTPError as retry_err:
                retry_body = retry_err.read().decode("utf-8")
                raise PaymentError(f"Payment rejected or settlement failed: {retry_body}")

    def chat(
        self,
        model: str,
        messages: Union[str, List[Dict[str, str]]],
        max_tokens: int = 1000,
        **kwargs,
    ) -> Dict[str, Any]:
        """OpenAI-compatible chat completion."""
        formatted_messages = (
            [{"role": "user", "content": messages}] if isinstance(messages, str) else messages
        )
        body = {"model": model, "messages": formatted_messages, "max_tokens": max_tokens, **kwargs}
        return self._execute_with_402_loop("/api/v1/chat/completions", body)

    def messages(
        self,
        model: str,
        messages: List[Dict[str, str]],
        max_tokens: int = 1000,
        system: Optional[str] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """Anthropic-compatible messages completion."""
        body = {"model": model, "messages": messages, "max_tokens": max_tokens, **kwargs}
        if system:
            body["system"] = system
        return self._execute_with_402_loop("/api/v1/messages", body)

    def smart_chat(
        self,
        messages: Union[str, List[Dict[str, str]]],
        profile: str = "auto",
        **kwargs,
    ) -> Dict[str, Any]:
        """Smart routing based on prompt complexity."""
        formatted_messages = (
            [{"role": "user", "content": messages}] if isinstance(messages, str) else messages
        )
        full_text = " ".join([m.get("content", "") for m in formatted_messages])

        if profile == "eco":
            target_model = "deepseek/deepseek-chat"
            tier = "eco"
            savings = "94%"
        elif profile == "premium":
            target_model = "openai/gpt-5.4"
            tier = "premium"
            savings = "0%"
        else:
            if len(full_text) > 400:
                target_model = "openai/gpt-5.4"
                tier = "premium"
                savings = "0%"
            else:
                target_model = "deepseek/deepseek-chat"
                tier = "eco"
                savings = "94%"

        res = self.chat(target_model, formatted_messages, **kwargs)
        res["routing"] = {
            "tier": tier,
            "selectedModel": target_model,
            "estimatedSavings": savings,
        }
        return res


def setup_agent_wallet(
    pem_path: Optional[str] = None,
    hex_seed: Optional[str] = None,
    gateway_url: str = "http://localhost:3000",
    network: str = "multiversx:1",
    **kwargs,
) -> BlockRunMvxClient:
    """Helper to initialize an autonomous agent client from a PEM or seed."""
    if pem_path:
        signer = UserSigner.from_pem_file(pem_path)
    elif hex_seed:
        signer = UserSigner.from_hex(hex_seed)
    else:
        signer = UserSigner.generate()

    return BlockRunMvxClient(signer=signer, gateway_url=gateway_url, network=network, **kwargs)
