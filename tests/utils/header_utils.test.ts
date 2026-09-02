import { describe, it, expect } from "vitest";
import {
  encodeHeaderJson,
  decodeHeaderJson,
  extractPaymentHeader,
  extractPaymentPayload,
  buildPaymentResponseHeaders,
} from "../../src/utils/header_utils.js";
import { X402PaymentPayload, SettleResponse, VerifyResponse, PaymentErrorCode } from "../../src/domain/types.js";

describe("Header Utilities (x402 Base64 & Headers)", () => {
  const samplePayload: X402PaymentPayload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "multiversx:1",
      asset: "USDC-c76f1f",
      amount: "1000000",
      payTo: "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th",
      maxTimeoutSeconds: 300,
    },
    payload: {
      nonce: 1,
      value: "0",
      receiver: "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th",
      sender: "erd1spyavw0956vq68xj8y4tenjpq2wd5a9p2c6j8gsz7ztyrnpxr3qsf07aze",
      gasPrice: 1000000000,
      gasLimit: 500000,
      chainID: "1",
      version: 1,
      options: 0,
      signature: "00".repeat(64),
    },
  };

  describe("encodeHeaderJson & decodeHeaderJson", () => {
    it("should encode object to base64 string and decode back losslessly", () => {
      const encoded = encodeHeaderJson(samplePayload);
      expect(typeof encoded).toBe("string");
      expect(encoded).not.toContain("{");

      const decoded = decodeHeaderJson<X402PaymentPayload>(encoded);
      expect(decoded).toEqual(samplePayload);
    });

    it("should support UTF-8 unicode characters correctly", () => {
      const complexObj = {
        title: "BlockRun ⚡ Payments — ȘșȚț € 😀",
        nested: { count: 42, active: true },
      };

      const encoded = encodeHeaderJson(complexObj);
      const decoded = decodeHeaderJson<typeof complexObj>(encoded);
      expect(decoded).toEqual(complexObj);
    });

    it("should handle undefined and null safely", () => {
      const encodedNull = encodeHeaderJson(null);
      expect(decodeHeaderJson(encodedNull)).toBeNull();

      const encodedUndefined = encodeHeaderJson(undefined);
      expect(decodeHeaderJson(encodedUndefined)).toBeNull();
    });

    it("should decode raw JSON string as fallback if not valid base64", () => {
      const jsonStr = JSON.stringify(samplePayload);
      const decoded = decodeHeaderJson<X402PaymentPayload>(jsonStr);
      expect(decoded).toEqual(samplePayload);
    });

    it("should throw informative error on invalid base64 and invalid JSON", () => {
      expect(() => decodeHeaderJson("invalid:::not-json-or-base64")).toThrow();
    });
  });

  describe("extractPaymentHeader", () => {
    it("should extract payment header from 'PAYMENT-SIGNATURE'", () => {
      const encoded = encodeHeaderJson(samplePayload);
      const headers = { "PAYMENT-SIGNATURE": encoded };
      expect(extractPaymentHeader(headers)).toBe(encoded);
    });

    it("should extract payment header case-insensitively from 'payment-signature'", () => {
      const encoded = encodeHeaderJson(samplePayload);
      const headers = { "payment-signature": encoded };
      expect(extractPaymentHeader(headers)).toBe(encoded);
    });

    it("should extract payment header from 'X-Payment' and 'x-payment'", () => {
      const encoded = encodeHeaderJson(samplePayload);
      expect(extractPaymentHeader({ "X-Payment": encoded })).toBe(encoded);
      expect(extractPaymentHeader({ "x-payment": encoded })).toBe(encoded);
    });

    it("should extract payment header from 'authorization' header (Bearer / x402)", () => {
      const encoded = encodeHeaderJson(samplePayload);
      expect(extractPaymentHeader({ authorization: `Bearer ${encoded}` })).toBe(encoded);
      expect(extractPaymentHeader({ authorization: `x402 ${encoded}` })).toBe(encoded);
    });

    it("should return undefined if no payment header is present", () => {
      expect(extractPaymentHeader({})).toBeUndefined();
      expect(extractPaymentHeader({ "content-type": "application/json" })).toBeUndefined();
    });
  });

  describe("extractPaymentPayload", () => {
    it("should extract and decode payload directly from headers", () => {
      const encoded = encodeHeaderJson(samplePayload);
      const headers = { "payment-signature": encoded };
      const payload = extractPaymentPayload(headers);
      expect(payload).toEqual(samplePayload);
    });

    it("should return undefined if header is missing or unparseable", () => {
      expect(extractPaymentPayload({})).toBeUndefined();
      expect(extractPaymentPayload({ "payment-signature": "not-valid-json" })).toBeUndefined();
    });
  });

  describe("buildPaymentResponseHeaders", () => {
    it("should build response headers for successful SettleResponse", () => {
      const settleResponse: SettleResponse = {
        success: true,
        transaction: "d1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        network: "multiversx:1",
        payer: "erd1spyavw0956vq68xj8y4tenjpq2wd5a9p2c6j8gsz7ztyrnpxr3qsf07aze",
      };

      const headers = buildPaymentResponseHeaders(settleResponse);
      expect(headers["PAYMENT-RESPONSE"]).toBe(encodeHeaderJson(settleResponse));
      expect(headers["X-Payment-Receipt"]).toBe(settleResponse.transaction);
      expect(headers["X-Payment-Settled"]).toBe("true");
    });

    it("should build response headers for failed SettleResponse", () => {
      const settleResponse: SettleResponse = {
        success: false,
        errorReason: "Insufficient balance",
        errorCode: PaymentErrorCode.PAYMENT_UNFUNDED,
        network: "multiversx:1",
      };

      const headers = buildPaymentResponseHeaders(settleResponse);
      expect(headers["PAYMENT-RESPONSE"]).toBe(encodeHeaderJson(settleResponse));
      expect(headers["X-Payment-Settled"]).toBe("false");
      expect(headers["X-Payment-Receipt"]).toBeUndefined();
    });

    it("should build response headers for VerifyResponse", () => {
      const verifyResponse: VerifyResponse = {
        isValid: true,
        payer: "erd1spyavw0956vq68xj8y4tenjpq2wd5a9p2c6j8gsz7ztyrnpxr3qsf07aze",
      };

      const headers = buildPaymentResponseHeaders(verifyResponse);
      expect(headers["PAYMENT-RESPONSE"]).toBe(encodeHeaderJson(verifyResponse));
    });
  });
});
