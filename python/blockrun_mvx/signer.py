"""
MultiversX Ed25519 signer and address management for Python SDK.
"""

import base64
import re
from typing import Union
import nacl.signing
from .bech32 import pubkey_to_address


class UserSigner:
    """Ed25519 Signer for MultiversX accounts."""

    def __init__(self, signing_key: nacl.signing.SigningKey):
        self._signing_key = signing_key
        self._verify_key = signing_key.verify_key
        self.address = pubkey_to_address(self._verify_key.encode())

    @classmethod
    def from_seed(cls, seed_bytes: bytes) -> "UserSigner":
        """Initializes signer from 32-byte seed."""
        if len(seed_bytes) != 32:
            raise ValueError(f"Seed must be 32 bytes, got {len(seed_bytes)}")
        key = nacl.signing.SigningKey(seed_bytes)
        return cls(key)

    @classmethod
    def from_hex(cls, hex_str: str) -> "UserSigner":
        """Initializes signer from 64-character hex seed string."""
        seed = bytes.fromhex(hex_str.strip())
        return cls.from_seed(seed)

    @classmethod
    def from_pem_file(cls, pem_path: str) -> "UserSigner":
        """Parses a standard MultiversX .pem file."""
        with open(pem_path, "r", encoding="utf-8") as f:
            content = f.read()
        return cls.from_pem_string(content)

    @classmethod
    def from_pem_string(cls, pem_content: str) -> "UserSigner":
        """Parses a standard MultiversX PEM content."""
        match = re.search(
            r"-----BEGIN PRIVATE KEY[^-]*-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY[^-]*-----",
            pem_content,
        )
        if not match:
            raise ValueError("Invalid PEM format: missing header/footer")

        b64_body = "".join(match.group(1).split())
        decoded_bytes = base64.b64decode(b64_body)

        try:
            hex_str = decoded_bytes.decode("ascii").strip()
            if len(hex_str) == 64:
                return cls.from_hex(hex_str)
        except UnicodeDecodeError:
            pass

        if len(decoded_bytes) == 32:
            return cls.from_seed(decoded_bytes)

        raise ValueError("Could not parse valid 32-byte private key from PEM")

    @classmethod
    def generate(cls) -> "UserSigner":
        """Generates a new random Ed25519 keypair."""
        key = nacl.signing.SigningKey.generate()
        return cls(key)

    def sign(self, message: bytes) -> bytes:
        """Signs a message using Ed25519 and returns the 64-byte signature."""
        signed = self._signing_key.sign(message)
        return signed.signature
