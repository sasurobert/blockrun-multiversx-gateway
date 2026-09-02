import { describe, it, expect } from "vitest";
import {
  PaymentErrorCode,
  PaymentErrorCodeSchema,
  MvxAddressSchema,
  MultiversXNetworkSchema,
  MvxTransactionPayloadSchema,
  PaymentRequirementsSchema,
  X402PaymentPayloadSchema,
  VerifyRequestSchema,
  VerifyResponseSchema,
  SettleRequestSchema,
  SettleResponseSchema,
  SupportedResponseSchema,
  SupportedKindSchema,
} from "../../src/domain/schemas.js";

describe("x402 v2 Domain Schemas & Types", () => {
  const validSender = "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th";
  const validReceiver = "erd1k2s324ww2g0yj38qn2ch2jwctdy8mnfxep94q9arncc6xecg3xaq6mjse8";
  const validRelayer = "erd1865ertye4x0956vq6xyxj8y9gdgdflxwwwsh9mexlh5xnsdexqqqvgx0a7";
  const validGuardian = "erd1k2s324ww2g0yj38qn2ch2jwctdy8mnfxep94q9arncc6xecg3xaq6mjse8";
  const validSignature =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const validRelayerSignature =
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const validGuardianSignature =
    "fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";

  describe("PaymentErrorCode", () => {
    it("should define standard x402 payment error codes", () => {
      expect(PaymentErrorCode.PAYMENT_UNFUNDED).toBe("PAYMENT_UNFUNDED");
      expect(PaymentErrorCode.PAYMENT_REPLAY).toBe("PAYMENT_REPLAY");
      expect(PaymentErrorCode.PAYMENT_INVALID).toBe("PAYMENT_INVALID");
      expect(PaymentErrorCode.PAYMENT_EXPIRED).toBe("PAYMENT_EXPIRED");
      expect(PaymentErrorCode.PAYMENT_BLOCKHASH_STALE).toBe("PAYMENT_BLOCKHASH_STALE");
    });

    it("should validate error codes with schema", () => {
      expect(PaymentErrorCodeSchema.safeParse("PAYMENT_UNFUNDED").success).toBe(true);
      expect(PaymentErrorCodeSchema.safeParse("PAYMENT_REPLAY").success).toBe(true);
      expect(PaymentErrorCodeSchema.safeParse("PAYMENT_INVALID").success).toBe(true);
      expect(PaymentErrorCodeSchema.safeParse("PAYMENT_EXPIRED").success).toBe(true);
      expect(PaymentErrorCodeSchema.safeParse("PAYMENT_BLOCKHASH_STALE").success).toBe(true);
      expect(PaymentErrorCodeSchema.safeParse("UNKNOWN_ERROR").success).toBe(false);
    });
  });

  describe("MvxAddressSchema", () => {
    it("should accept valid MultiversX bech32 addresses", () => {
      expect(MvxAddressSchema.safeParse(validSender).success).toBe(true);
      expect(MvxAddressSchema.safeParse(validReceiver).success).toBe(true);
      expect(MvxAddressSchema.safeParse(validRelayer).success).toBe(true);
    });

    it("should reject uppercase and invalid bech32 characters", () => {
      expect(MvxAddressSchema.safeParse(validSender.toUpperCase()).success).toBe(false);
      expect(MvxAddressSchema.safeParse("erd1" + "B".repeat(58)).success).toBe(false);
    });

    it("should reject invalid addresses", () => {
      expect(MvxAddressSchema.safeParse("0x1234567890abcdef1234567890abcdef12345678").success).toBe(false);
      expect(MvxAddressSchema.safeParse("erd1short").success).toBe(false);
      expect(MvxAddressSchema.safeParse("erd2qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th").success).toBe(false);
      expect(MvxAddressSchema.safeParse("").success).toBe(false);
    });
  });

  describe("MultiversXNetworkSchema", () => {
    it("should accept valid MultiversX CAIP network identifiers", () => {
      expect(MultiversXNetworkSchema.safeParse("multiversx:1").success).toBe(true);
      expect(MultiversXNetworkSchema.safeParse("multiversx:D").success).toBe(true);
      expect(MultiversXNetworkSchema.safeParse("multiversx:T").success).toBe(true);
      expect(MultiversXNetworkSchema.safeParse("multiversx:shadowfork").success).toBe(true);
    });

    it("should reject invalid network formats", () => {
      expect(MultiversXNetworkSchema.safeParse("ethereum:1").success).toBe(false);
      expect(MultiversXNetworkSchema.safeParse("solana:mainnet").success).toBe(false);
      expect(MultiversXNetworkSchema.safeParse("invalid").success).toBe(false);
    });
  });

  describe("MvxTransactionPayloadSchema", () => {
    const validTxPayload = {
      nonce: 42,
      value: "1000000000000000000",
      receiver: validReceiver,
      sender: validSender,
      gasPrice: 1000000000,
      gasLimit: 70000,
      data: "pay",
      chainID: "D",
      version: 2,
      options: 0,
      signature: validSignature,
      relayer: validRelayer,
      relayerSignature: validRelayerSignature,
      guardian: validGuardian,
      guardianSignature: validGuardianSignature,
      validAfter: 1700000000,
      validBefore: 1700003600,
    };

    it("should validate full Relayed V3 transaction payload with relayer and guardian", () => {
      const result = MvxTransactionPayloadSchema.safeParse(validTxPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.nonce).toBe(42);
        expect(result.data.sender).toBe(validSender);
        expect(result.data.relayer).toBe(validRelayer);
        expect(result.data.guardian).toBe(validGuardian);
      }
    });

    it("should validate direct transaction payload without relayer fields", () => {
      const directTx = {
        nonce: 0,
        value: "500000000000000000",
        receiver: validReceiver,
        sender: validSender,
        gasPrice: 1000000000,
        gasLimit: 50000,
        chainID: "1",
        version: 1,
        options: 0,
        signature: validSignature,
      };
      const result = MvxTransactionPayloadSchema.safeParse(directTx);
      expect(result.success).toBe(true);
    });

    it("should reject transaction with invalid signature length or chars", () => {
      const invalidTx = {
        ...validTxPayload,
        signature: "invalid_sig_short",
      };
      expect(MvxTransactionPayloadSchema.safeParse(invalidTx).success).toBe(false);
    });

    it("should reject transaction with invalid value string", () => {
      const invalidTx = {
        ...validTxPayload,
        value: "-100",
      };
      expect(MvxTransactionPayloadSchema.safeParse(invalidTx).success).toBe(false);
    });

    it("should reject negative nonce or gasLimit", () => {
      expect(MvxTransactionPayloadSchema.safeParse({ ...validTxPayload, nonce: -1 }).success).toBe(false);
      expect(MvxTransactionPayloadSchema.safeParse({ ...validTxPayload, gasLimit: -500 }).success).toBe(false);
    });
  });

  describe("PaymentRequirementsSchema", () => {
    const validReqs = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "USDC-c76f1f",
      amount: "1000000",
      payTo: validReceiver,
      maxTimeoutSeconds: 300,
      extra: {
        assetTransferMethod: "esdt",
      },
    };

    it("should validate exact payment requirements", () => {
      const result = PaymentRequirementsSchema.safeParse(validReqs);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scheme).toBe("exact");
        expect(result.data.network).toBe("multiversx:D");
        expect(result.data.asset).toBe("USDC-c76f1f");
      }
    });

    it("should reject unsupported scheme", () => {
      const invalidReqs = {
        ...validReqs,
        scheme: "deferred",
      };
      expect(PaymentRequirementsSchema.safeParse(invalidReqs).success).toBe(false);
    });

    it("should reject non-positive maxTimeoutSeconds", () => {
      expect(PaymentRequirementsSchema.safeParse({ ...validReqs, maxTimeoutSeconds: 0 }).success).toBe(false);
      expect(PaymentRequirementsSchema.safeParse({ ...validReqs, maxTimeoutSeconds: -60 }).success).toBe(false);
    });

    it("should reject non-numeric amount", () => {
      expect(PaymentRequirementsSchema.safeParse({ ...validReqs, amount: "10.50" }).success).toBe(false);
      expect(PaymentRequirementsSchema.safeParse({ ...validReqs, amount: "abc" }).success).toBe(false);
    });
  });

  describe("X402PaymentPayloadSchema", () => {
    const validRequirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: "100000000000000000",
      payTo: validReceiver,
      maxTimeoutSeconds: 60,
    };

    const validTxPayload = {
      nonce: 10,
      value: "100000000000000000",
      receiver: validReceiver,
      sender: validSender,
      gasPrice: 1000000000,
      gasLimit: 70000,
      chainID: "D",
      version: 2,
      options: 0,
      signature: validSignature,
    };

    it("should validate x402 v2 payment payload with { signature, transaction }", () => {
      const v2Payload = {
        x402Version: 2 as const,
        resource: {
          url: "https://api.gateway.blockrun.io/v1/inference",
          description: "LLM Inference Payment",
          mimeType: "application/json",
        },
        accepted: validRequirements,
        payload: {
          signature: validSignature,
          transaction: validTxPayload,
        },
        extensions: {
          traceId: "trace-12345",
        },
      };

      const result = X402PaymentPayloadSchema.safeParse(v2Payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.x402Version).toBe(2);
        expect(result.data.accepted.asset).toBe("EGLD");
      }
    });

    it("should validate x402 v2 payment payload with direct transaction in payload", () => {
      const v2Payload = {
        x402Version: 2 as const,
        accepted: validRequirements,
        payload: validTxPayload,
      };

      const result = X402PaymentPayloadSchema.safeParse(v2Payload);
      expect(result.success).toBe(true);
    });

    it("should reject wrong x402Version", () => {
      const v1Payload = {
        x402Version: 1,
        accepted: validRequirements,
        payload: validTxPayload,
      };

      expect(X402PaymentPayloadSchema.safeParse(v1Payload).success).toBe(false);
    });

    it("should reject missing accepted requirements", () => {
      const invalidPayload = {
        x402Version: 2,
        payload: validTxPayload,
      };

      expect(X402PaymentPayloadSchema.safeParse(invalidPayload).success).toBe(false);
    });
  });

  describe("VerifyRequestSchema and VerifyResponseSchema", () => {
    const validRequirements = {
      scheme: "exact" as const,
      network: "multiversx:1",
      asset: "EGLD",
      amount: "1000000000000000000",
      payTo: validReceiver,
      maxTimeoutSeconds: 120,
    };

    const validPaymentPayload = {
      x402Version: 2 as const,
      accepted: validRequirements,
      payload: {
        signature: validSignature,
        transaction: {
          nonce: 5,
          value: "1000000000000000000",
          receiver: validReceiver,
          sender: validSender,
          gasPrice: 1000000000,
          gasLimit: 50000,
          chainID: "1",
          version: 1,
          options: 0,
          signature: validSignature,
        },
      },
    };

    it("should validate VerifyRequestSchema", () => {
      const verifyReq = {
        paymentPayload: validPaymentPayload,
        paymentRequirements: validRequirements,
      };

      const result = VerifyRequestSchema.safeParse(verifyReq);
      expect(result.success).toBe(true);
    });

    it("should validate valid VerifyResponseSchema on success", () => {
      const successRes = {
        isValid: true,
        payer: validSender,
      };
      const result = VerifyResponseSchema.safeParse(successRes);
      expect(result.success).toBe(true);
    });

    it("should validate valid VerifyResponseSchema on failure with error code", () => {
      const failRes = {
        isValid: false,
        invalidReason: "Account balance insufficient",
        errorCode: PaymentErrorCode.PAYMENT_UNFUNDED,
        payer: validSender,
      };
      const result = VerifyResponseSchema.safeParse(failRes);
      expect(result.success).toBe(true);
    });
  });

  describe("SettleRequestSchema and SettleResponseSchema", () => {
    const validRequirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "USDC-c76f1f",
      amount: "5000000",
      payTo: validReceiver,
      maxTimeoutSeconds: 180,
    };

    const validPaymentPayload = {
      x402Version: 2 as const,
      accepted: validRequirements,
      payload: {
        signature: validSignature,
        transaction: {
          nonce: 12,
          value: "0",
          receiver: validSender,
          sender: validSender,
          gasPrice: 1000000000,
          gasLimit: 300000,
          data: "MultiESDTNFTTransfer@00",
          chainID: "D",
          version: 2,
          options: 0,
          signature: validSignature,
          relayer: validRelayer,
        },
      },
    };

    it("should validate SettleRequestSchema", () => {
      const settleReq = {
        paymentPayload: validPaymentPayload,
        paymentRequirements: validRequirements,
      };

      const result = SettleRequestSchema.safeParse(settleReq);
      expect(result.success).toBe(true);
    });

    it("should validate SettleResponseSchema on success", () => {
      const settleSuccess = {
        success: true,
        transaction: "4b9f2b8471e98218128f7311181829e190344d9f67a6850c904975253818e380",
        network: "multiversx:D",
        payer: validSender,
      };

      const result = SettleResponseSchema.safeParse(settleSuccess);
      expect(result.success).toBe(true);
    });

    it("should validate SettleResponseSchema on failure with error code", () => {
      const settleFail = {
        success: false,
        errorReason: "Transaction replay detected",
        errorCode: PaymentErrorCode.PAYMENT_REPLAY,
        payer: validSender,
      };

      const result = SettleResponseSchema.safeParse(settleFail);
      expect(result.success).toBe(true);
    });
  });

  describe("SupportedResponseSchema", () => {
    it("should validate standard SupportedResponse with kinds, extensions, signers", () => {
      const supportedRes = {
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "multiversx:1",
            extra: {
              assetTransferMethod: ["direct", "esdt"],
            },
          },
          {
            x402Version: 2,
            scheme: "exact",
            network: "multiversx:D",
          },
        ],
        extensions: ["multiversx-relayed-v3", "token-simulation"],
        signers: {
          "multiversx:1": [validRelayer],
          "multiversx:D": [validRelayer],
        },
      };

      const result = SupportedResponseSchema.safeParse(supportedRes);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kinds.length).toBe(2);
        expect(result.data.signers["multiversx:1"]).toContain(validRelayer);
      }
    });

    it("should validate SupportedKindSchema individually", () => {
      const kind = {
        x402Version: 2,
        scheme: "exact",
        network: "multiversx:1",
      };
      expect(SupportedKindSchema.safeParse(kind).success).toBe(true);
    });

    it("should reject SupportedResponse with invalid signer address", () => {
      const invalidSupported = {
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "multiversx:1",
          },
        ],
        extensions: [],
        signers: {
          "multiversx:1": ["invalid_address"],
        },
      };

      expect(SupportedResponseSchema.safeParse(invalidSupported).success).toBe(false);
    });
  });
});
