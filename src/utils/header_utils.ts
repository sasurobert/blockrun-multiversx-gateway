import { X402PaymentPayload, SettleResponse, VerifyResponse } from "../domain/types.js";

/**
 * Encodes an arbitrary JavaScript object or value to a UTF-8 Base64 string for HTTP headers.
 */
export function encodeHeaderJson(obj: unknown): string {
  const jsonStr = JSON.stringify(obj ?? null);
  return Buffer.from(jsonStr, "utf8").toString("base64");
}

/**
 * Decodes a Base64-encoded UTF-8 string or raw JSON string into a parsed JSON object.
 */
export function decodeHeaderJson<T = unknown>(headerValue: string): T {
  const trimmed = headerValue.trim();

  // Try direct JSON parse first if it starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Fall through to base64 decoding attempt
    }
  }

  // Attempt Base64 decode
  try {
    const decodedStr = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(decodedStr) as T;
  } catch {
    // If base64 decode didn't work, try direct JSON parse as fallback
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new Error(`Failed to decode header value as base64 JSON or plain JSON: ${trimmed.slice(0, 50)}`);
    }
  }
}

/**
 * Extracts the raw payment signature/payload header string from standard and fallback HTTP headers.
 * Supported headers:
 * - PAYMENT-SIGNATURE / payment-signature / Payment-Signature
 * - X-Payment / x-payment / X-PAYMENT
 * - Authorization: Bearer <base64> / x402 <base64>
 */
export function extractPaymentHeader(
  headers: Record<string, string | string[] | undefined> | undefined
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
  }

  const lookup = (key: string): string | undefined => {
    return normalizedHeaders[key.toLowerCase()];
  };

  // 1. Direct x402 header variants
  const sigHeader =
    lookup("payment-signature") ??
    lookup("payment_signature") ??
    lookup("x-payment") ??
    lookup("x_payment") ??
    lookup("x-payment-signature");

  if (sigHeader && typeof sigHeader === "string" && sigHeader.trim().length > 0) {
    const val = sigHeader.trim();
    return val.includes(",") ? val.split(",")[0].trim() : val;
  }

  // 2. Authorization header variants (Bearer <payload> or x402 <payload>)
  const authHeader = lookup("authorization");
  if (authHeader && typeof authHeader === "string") {
    let trimmedAuth = authHeader.trim();
    if (trimmedAuth.includes(",")) {
      trimmedAuth = trimmedAuth.split(",")[0].trim();
    }
    if (trimmedAuth.toLowerCase().startsWith("bearer ")) {
      return trimmedAuth.slice(7).trim();
    }
    if (trimmedAuth.toLowerCase().startsWith("x402 ")) {
      return trimmedAuth.slice(5).trim();
    }
  }

  return undefined;
}

/**
 * Extracts and decodes an X402PaymentPayload directly from request headers.
 */
export function extractPaymentPayload(
  headers: Record<string, string | string[] | undefined> | undefined
): X402PaymentPayload | undefined {
  const headerVal = extractPaymentHeader(headers);
  if (!headerVal) {
    return undefined;
  }

  try {
    return decodeHeaderJson<X402PaymentPayload>(headerVal);
  } catch {
    return undefined;
  }
}

/**
 * Builds standard x402 payment response headers from a settlement or verification response.
 */
export function buildPaymentResponseHeaders(
  response: SettleResponse | VerifyResponse | Record<string, unknown>
): Record<string, string> {
  const headers: Record<string, string> = {
    "PAYMENT-RESPONSE": encodeHeaderJson(response),
  };

  if ("transaction" in response && typeof response.transaction === "string" && response.transaction) {
    headers["X-Payment-Receipt"] = response.transaction;
  }

  if ("success" in response && typeof response.success === "boolean") {
    headers["X-Payment-Settled"] = response.success ? "true" : "false";
  }

  return headers;
}
