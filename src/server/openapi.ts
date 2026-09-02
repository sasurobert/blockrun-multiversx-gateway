/**
 * OpenAPI 3.1.0 specification generator for the BlockRun MultiversX x402 Facilitator Gateway.
 */
export function generateOpenApiSpec(options?: {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
}): Record<string, unknown> {
  const title = options?.title ?? "BlockRun MultiversX x402 Facilitator API";
  const version = options?.version ?? "2.0.0";
  const description =
    options?.description ??
    "x402 v2 payment facilitator and gasless Relayed V3 settlement gateway for MultiversX.";

  return {
    openapi: "3.1.0",
    info: {
      title,
      version,
      description,
      contact: {
        name: "BlockRun Protocol",
        url: "https://blockrun.ai",
      },
    },
    servers: options?.serverUrl ? [{ url: options.serverUrl }] : [{ url: "/" }],
    paths: {
      "/verify": {
        post: {
          summary: "Verify x402 v2 payment payload",
          description:
            "Verifies cryptographic signatures, balances, timeout windows, and transaction validity for MultiversX ESDT / EGLD transfers.",
          operationId: "verifyPayment",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/VerifyRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Verification result",
              headers: {
                "PAYMENT-RESPONSE": {
                  description: "Base64 encoded JSON verification response",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/VerifyResponse",
                  },
                },
              },
            },
            "400": {
              description: "Invalid request payload format",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/settle": {
        post: {
          summary: "Settle x402 v2 payment transaction",
          description:
            "Verifies, countersigns (for Relayed V3), and broadcasts transaction through shard-partitioned settlement queues.",
          operationId: "settlePayment",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/SettleRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Settlement result with transaction receipt",
              headers: {
                "PAYMENT-RESPONSE": {
                  description: "Base64 encoded JSON settlement response",
                  schema: { type: "string" },
                },
                "X-Payment-Receipt": {
                  description: "MultiversX transaction hash (on success)",
                  schema: { type: "string" },
                },
                "X-Payment-Settled": {
                  description: "Whether payment settlement succeeded ('true' or 'false')",
                  schema: { type: "string", enum: ["true", "false"] },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SettleResponse",
                  },
                },
              },
            },
            "400": {
              description: "Invalid request format",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/supported": {
        get: {
          summary: "Get supported payment kinds and signer capabilities",
          description:
            "Returns supported network kinds, extensions ('bazaar', 'relayed-v3'), and relayer signer addresses.",
          operationId: "getSupported",
          responses: {
            "200": {
              description: "Supported facilitator capabilities",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/SupportedResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/.well-known/x402": {
        get: {
          summary: "x402 Protocol Discovery Endpoint",
          description:
            "Discovery endpoint providing protocol version, gateway metadata, and API route endpoints.",
          operationId: "getX402Discovery",
          responses: {
            "200": {
              description: "x402 discovery metadata",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/DiscoveryResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/health": {
        get: {
          summary: "Facilitator health check and queue metrics",
          description: "Returns health status, version, and shard queue metrics.",
          operationId: "getHealth",
          responses: {
            "200": {
              description: "Health status",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/HealthResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/relayer/address/{userAddress}": {
        get: {
          summary: "Resolve relayer address for a MultiversX user address",
          description:
            "Computes the user's shard ID and returns the corresponding co-located relayer address for gasless Relayed V3 transactions.",
          operationId: "getRelayerAddressForUser",
          parameters: [
            {
              name: "userAddress",
              in: "path",
              required: true,
              description: "MultiversX bech32 address (erd1...)",
              schema: {
                type: "string",
                pattern: "^erd1[0-9a-z]{58}$",
              },
            },
          ],
          responses: {
            "200": {
              description: "Relayer address and shard",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      relayerAddress: { type: "string" },
                      shard: { type: "number" },
                    },
                    required: ["relayerAddress", "shard"],
                  },
                },
              },
            },
            "400": {
              description: "Invalid address format",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/relayer/shards": {
        get: {
          summary: "List all configured relayer addresses and shards",
          description: "Returns map of shards to relayer addresses.",
          operationId: "getRelayerShards",
          responses: {
            "200": {
              description: "Relayers by shard",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      relayers: {
                        type: "object",
                        additionalProperties: { type: "string" },
                      },
                      shards: {
                        type: "array",
                        items: { type: "number" },
                      },
                    },
                    required: ["relayers", "shards"],
                  },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI Specification",
          description: "Returns OpenAPI 3.1.0 specification for the facilitator.",
          operationId: "getOpenApiSpec",
          responses: {
            "200": {
              description: "OpenAPI document",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PaymentErrorCode: {
          type: "string",
          enum: [
            "PAYMENT_UNFUNDED",
            "PAYMENT_REPLAY",
            "PAYMENT_INVALID",
            "PAYMENT_EXPIRED",
            "PAYMENT_BLOCKHASH_STALE",
          ],
        },
        PaymentRequirements: {
          type: "object",
          properties: {
            scheme: { type: "string", enum: ["exact"] },
            network: { type: "string", pattern: "^multiversx:[a-zA-Z0-9_-]+$" },
            asset: { type: "string" },
            amount: { type: "string", pattern: "^\\d+$" },
            payTo: { type: "string", pattern: "^erd1[0-9a-z]{58}$" },
            maxTimeoutSeconds: { type: "number" },
            extra: { type: "object" },
          },
          required: ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"],
        },
        MvxTransactionPayload: {
          type: "object",
          properties: {
            nonce: { type: "integer", minimum: 0 },
            value: { type: "string", pattern: "^\\d+$" },
            receiver: { type: "string", pattern: "^erd1[0-9a-z]{58}$" },
            sender: { type: "string", pattern: "^erd1[0-9a-z]{58}$" },
            gasPrice: { type: "integer", minimum: 0 },
            gasLimit: { type: "integer", minimum: 0 },
            data: { type: "string" },
            chainID: { type: "string" },
            version: { type: "integer", minimum: 0 },
            options: { type: "integer", minimum: 0 },
            signature: { type: "string", pattern: "^[0-9a-fA-F]{128}$" },
            relayer: { type: "string", pattern: "^erd1[0-9a-z]{58}$" },
            relayerSignature: { type: "string", pattern: "^[0-9a-fA-F]{128}$" },
            guardian: { type: "string", pattern: "^erd1[0-9a-z]{58}$" },
            guardianSignature: { type: "string", pattern: "^[0-9a-fA-F]{128}$" },
            validAfter: { type: "integer", minimum: 0 },
            validBefore: { type: "integer", minimum: 0 },
          },
          required: [
            "nonce",
            "value",
            "receiver",
            "sender",
            "gasPrice",
            "gasLimit",
            "chainID",
            "version",
            "options",
            "signature",
          ],
        },
        X402PaymentPayload: {
          type: "object",
          properties: {
            x402Version: { type: "integer", enum: [2] },
            resource: {
              type: "object",
              properties: {
                url: { type: "string" },
                description: { type: "string" },
                mimeType: { type: "string" },
              },
              required: ["url"],
            },
            accepted: { $ref: "#/components/schemas/PaymentRequirements" },
            payload: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    signature: { type: "string" },
                    transaction: { $ref: "#/components/schemas/MvxTransactionPayload" },
                  },
                  required: ["transaction"],
                },
                { $ref: "#/components/schemas/MvxTransactionPayload" },
              ],
            },
            extensions: { type: "object" },
          },
          required: ["x402Version", "accepted", "payload"],
        },
        VerifyRequest: {
          type: "object",
          properties: {
            paymentPayload: { $ref: "#/components/schemas/X402PaymentPayload" },
            paymentRequirements: { $ref: "#/components/schemas/PaymentRequirements" },
          },
          required: ["paymentPayload", "paymentRequirements"],
        },
        VerifyResponse: {
          type: "object",
          properties: {
            isValid: { type: "boolean" },
            invalidReason: { type: "string" },
            errorCode: { $ref: "#/components/schemas/PaymentErrorCode" },
            payer: { type: "string" },
            extensions: { type: "object" },
          },
          required: ["isValid"],
        },
        SettleRequest: {
          type: "object",
          properties: {
            paymentPayload: { $ref: "#/components/schemas/X402PaymentPayload" },
            paymentRequirements: { $ref: "#/components/schemas/PaymentRequirements" },
          },
          required: ["paymentPayload", "paymentRequirements"],
        },
        SettleResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            transaction: { type: "string" },
            network: { type: "string" },
            payer: { type: "string" },
            errorReason: { type: "string" },
            errorCode: { $ref: "#/components/schemas/PaymentErrorCode" },
            extensions: { type: "object" },
          },
          required: ["success"],
        },
        SupportedKind: {
          type: "object",
          properties: {
            x402Version: { type: "integer", enum: [2] },
            scheme: { type: "string" },
            network: { type: "string" },
            extra: { type: "object" },
          },
          required: ["x402Version", "scheme", "network"],
        },
        SupportedResponse: {
          type: "object",
          properties: {
            kinds: {
              type: "array",
              items: { $ref: "#/components/schemas/SupportedKind" },
            },
            extensions: {
              type: "array",
              items: { type: "string" },
            },
            signers: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          required: ["kinds", "extensions", "signers"],
        },
        DiscoveryResponse: {
          type: "object",
          properties: {
            x402Version: { type: "integer" },
            name: { type: "string" },
            version: { type: "string" },
            supported: { $ref: "#/components/schemas/SupportedResponse" },
            endpoints: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["x402Version", "name", "version", "supported", "endpoints"],
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string" },
            timestamp: { type: "string" },
            version: { type: "string" },
            queueStats: { type: "object" },
            pendingCount: { type: "number" },
          },
          required: ["status", "timestamp", "version", "queueStats", "pendingCount"],
        },
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
            details: { type: "object" },
          },
          required: ["error"],
        },
      },
    },
  };
}
