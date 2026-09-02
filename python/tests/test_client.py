"""
Unit tests for BlockRun MultiversX Python Client SDK.
"""

import base64
import json
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError
import io

from blockrun_mvx import BlockRunMvxClient, setup_agent_wallet, UserSigner
from blockrun_mvx.errors import SpendLimitError, PaymentError, APIError


class TestBlockRunMvxPython(unittest.TestCase):
    def setUp(self):
        self.signer = UserSigner.from_seed(bytes([42] * 32))
        self.client = BlockRunMvxClient(
            signer=self.signer,
            gateway_url="http://127.0.0.1:3000",
            network="multiversx:1",
            relayer_address="erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu",
        )

    def test_address_derivation(self):
        address = self.client.get_wallet_address()
        self.assertTrue(address.startswith("erd1"))
        self.assertEqual(len(address), 62)

    def test_immediate_200_response(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"choices": [{"message": {"content": "Hello!"}}]}).encode("utf-8")
        mock_resp.headers = {"x-payment-receipt": "tx-12345"}
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            res = self.client.chat("openai/gpt-5.4", "Hi")
            self.assertEqual(res["choices"][0]["message"]["content"], "Hello!")
            self.assertEqual(res["paymentReceipt"], "tx-12345")

    def test_autonomous_402_payment_loop(self):
        challenge_body = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "multiversx:1",
                    "amount": "1000",
                    "asset": "USDC-c76f1f",
                    "payTo": "erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu",
                    "extra": {"decimals": 6},
                }
            ],
        }

        # First call raises HTTPError 402, second call succeeds
        http_err_402 = HTTPError(
            url="http://127.0.0.1:3000/api/v1/chat/completions",
            code=402,
            msg="Payment Required",
            hdrs={"PAYMENT-REQUIRED": base64.b64encode(json.dumps(challenge_body).encode("utf-8")).decode("ascii")},
            fp=io.BytesIO(json.dumps(challenge_body).encode("utf-8")),
        )

        success_resp = MagicMock()
        success_resp.read.return_value = json.dumps({"choices": [{"message": {"content": "Payment accepted!"}}]}).encode("utf-8")
        success_resp.headers = {"x-payment-receipt": "tx-settled-402"}
        success_resp.__enter__.return_value = success_resp

        with patch("urllib.request.urlopen", side_effect=[http_err_402, success_resp]):
            res = self.client.chat("openai/gpt-5.4", "Query")
            self.assertEqual(res["choices"][0]["message"]["content"], "Payment accepted!")
            self.assertEqual(res["paymentReceipt"], "tx-settled-402")
            self.assertAlmostEqual(self.client.get_session_spend(), 0.001, places=6)

    def test_spend_limit_error_on_exceeded_cost(self):
        self.client.max_cost_per_call = 0.0005  # $0.0005 max cost

        challenge_body = {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "multiversx:1",
                    "amount": "1000",  # $0.0010
                    "asset": "USDC-c76f1f",
                    "payTo": "erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu",
                    "extra": {"decimals": 6},
                }
            ],
        }

        http_err_402 = HTTPError(
            url="http://127.0.0.1:3000/api/v1/chat/completions",
            code=402,
            msg="Payment Required",
            hdrs={"PAYMENT-REQUIRED": base64.b64encode(json.dumps(challenge_body).encode("utf-8")).decode("ascii")},
            fp=io.BytesIO(json.dumps(challenge_body).encode("utf-8")),
        )

        with patch("urllib.request.urlopen", side_effect=http_err_402):
            with self.assertRaises(SpendLimitError):
                self.client.chat("openai/gpt-5.4", "Query")

    def test_smart_chat_routing(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"choices": [{"message": {"content": "Routed!"}}]}).encode("utf-8")
        mock_resp.headers = {}
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            res = self.client.smart_chat("Short question", profile="eco")
            self.assertEqual(res["routing"]["tier"], "eco")
            self.assertEqual(res["routing"]["selectedModel"], "deepseek/deepseek-chat")


if __name__ == "__main__":
    unittest.main()
