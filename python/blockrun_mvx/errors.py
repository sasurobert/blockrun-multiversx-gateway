"""
Exceptions for the BlockRun MultiversX Client SDK.
"""

from typing import Optional, Any


class BlockRunError(Exception):
    """Base exception for all BlockRun client errors."""
    pass


class PaymentError(BlockRunError):
    """Raised when on-chain payment or settlement fails."""
    def __init__(self, message: str, code: Optional[str] = None, details: Optional[Any] = None):
        super().__init__(message)
        self.code = code
        self.details = details


class SpendLimitError(BlockRunError):
    """Raised when an autonomous request exceeds user-configured spend limits."""
    def __init__(self, message: str, limit_type: str, requested: float, limit: float):
        super().__init__(message)
        self.limit_type = limit_type
        self.requested = requested
        self.limit = limit


class APIError(BlockRunError):
    """Raised when the gateway or AI provider returns an HTTP error."""
    def __init__(self, message: str, status_code: int, details: Optional[Any] = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details
