/**
 * Base class for all BlockRun MultiversX Client SDK errors.
 */
export class BlockRunClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a payment fails, verification is rejected, or the wallet is underfunded.
 */
export class PaymentError extends BlockRunClientError {
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    options?: { code?: string; details?: unknown; cause?: unknown }
  ) {
    super(message);
    this.code = options?.code;
    this.details = options?.details;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * Thrown when an AI inference request's price exceeds client-configured spend limits
 * (either maxCostPerCall or maxSessionCost).
 */
export class SpendLimitError extends BlockRunClientError {
  public readonly limitType: "call" | "session";
  public readonly requestedCost: number;
  public readonly limit: number;

  constructor(
    message: string,
    limitType: "call" | "session" = "call",
    requestedCost: number = 0,
    limit: number = 0
  ) {
    super(message);
    this.limitType = limitType;
    this.requestedCost = requestedCost;
    this.limit = limit;
  }
}

/**
 * Thrown when the BlockRun AI Gateway or upstream AI provider returns an HTTP error status code.
 */
export class APIError extends BlockRunClientError {
  public readonly statusCode: number;
  public readonly responseBody?: unknown;

  constructor(message: string, statusCode: number, responseBody?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
