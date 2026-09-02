import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import http from "http";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { Express } from "express";
import {
  PaymentRequirements,
  X402PaymentPayload,
} from "../../src/domain/types.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { VerifierService } from "../../src/services/verifier.js";
import { SettlerService } from "../../src/services/settler.js";
import { SettlementQueue } from "../../src/services/settlement_queue.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";
import { buildEsdtTransferData } from "../../src/utils/data_parser.js";
import { encodeHeaderJson, decodeHeaderJson } from "../../src/utils/header_utils.js";
import {
  createBlockRunGateway,
  BlockRunGatewayOptions,
} from "../../src/gateway/blockrun_gateway.js";
import { DEFAULT_MODEL_CATALOG } from "../../src/gateway/model_catalog.js";

describe("BlockRun AI Gateway Proxy Server", () => {
  let app: Express;
  let server: http.Server;
  let userMnemonic: Mnemonic;
  let userSigner: UserSigner;
  let userAddress: Address;

  let merchantMnemonic: Mnemonic;
  let merchantSigner: UserSigner;
  let merchantAddress: Address;

  let relayerPool: RelayerPoolManager;
  let verifier: VerifierService;
  let settler: SettlerService;
  let settlementQueue: SettlementQueue;
  let storage: MemorySettlementStorage;
  let broadcastedTxs: Transaction[];
  let tc: TransactionComputer;

  async function createPaymentPayload(
    requirements: PaymentRequirements,
    options?: { corruptSignature?: boolean; tamperAmount?: string }
  ): Promise<X402PaymentPayload> {
    const amount = options?.tamperAmount ?? requirements.amount;
    const asset = requirements.asset;
    const relayerAddrStr = relayerPool.getRelayerAddressForUser(userAddress.toBech32());

    const tx = new Transaction({
      nonce: 1n,
      value: 0n,
      sender: userAddress,
      receiver: Address.newFromBech32(requirements.payTo),
      gasPrice: 1000000000n,
      gasLimit: 500000n,
      data: Buffer.from(buildEsdtTransferData(asset, amount)),
      chainID: "1",
      version: 2,
      options: 0,
      relayer: Address.newFromBech32(relayerAddrStr),
    });

    const bytesToSign = tc.computeBytesForSigning(tx);
    const userSig = await userSigner.sign(bytesToSign);
    const sigHex = options?.corruptSignature ? "00".repeat(64) : userSig.toString("hex");

    return {
      x402Version: 2,
      resource: {
        url: "https://api.blockrun.ai/v1/chat/completions",
        description: "AI Inference Payment",
      },
      accepted: {
        ...requirements,
        amount,
      },
      payload: {
        nonce: 1,
        value: "0",
        receiver: requirements.payTo,
        sender: userAddress.toBech32(),
        gasPrice: 1000000000,
        gasLimit: 500000,
        data: buildEsdtTransferData(asset, amount),
        chainID: "1",
        version: 2,
        options: 0,
        signature: sigHex,
        relayer: relayerAddrStr,
      },
    };
  }

  beforeEach(async () => {
    tc = new TransactionComputer();
    broadcastedTxs = [];
    storage = new MemorySettlementStorage();

    userMnemonic = Mnemonic.generate();
    userSigner = new UserSigner(userMnemonic.deriveKey(0));
    userAddress = Address.newFromBech32(userSigner.getAddress().bech32());

    merchantMnemonic = Mnemonic.generate();
    merchantSigner = new UserSigner(merchantMnemonic.deriveKey(0));
    merchantAddress = Address.newFromBech32(merchantSigner.getAddress().bech32());

    const relayerMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString(), { maxScanIndex: 250 });

    const mockNetworkProvider: INetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      sendTransaction: async (tx: Transaction): Promise<string> => {
        broadcastedTxs.push(tx);
        return "tx-hash-" + broadcastedTxs.length;
      },
      getTransaction: async () => ({ status: "success" }),
      getAccount: async () => ({ nonce: 1, balance: "1000000000000000000" }),
    };

    verifier = new VerifierService({
      relayerPool,
      networkProvider: mockNetworkProvider,
    });

    settler = new SettlerService({
      storage,
      networkProvider: mockNetworkProvider,
      relayerPool,
      verifier,
    });

    settlementQueue = new SettlementQueue({
      settler,
      relayerPool,
      maxRetries: 1,
      baseDelayMs: 10,
    });

    app = createBlockRunGateway({
      verifier,
      settlementQueue,
      payTo: merchantAddress.toBech32(),
      rateLimit: { enabled: false },
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  describe("GET /health", () => {
    it("should return healthy gateway status and metadata", async () => {
      const res = await request(server).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.version).toBeDefined();
      expect(res.body.modelsCount).toBe(DEFAULT_MODEL_CATALOG.length);
      expect(res.body.payTo).toBe(merchantAddress.toBech32());
    });
  });

  describe("GET /api/v1/models", () => {
    it("should list available models with context length and token pricing", async () => {
      const res = await request(server).get("/api/v1/models");
      expect(res.status).toBe(200);
      expect(res.body.object).toBe("list");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(DEFAULT_MODEL_CATALOG.length);

      const gptModel = res.body.data.find((m: any) => m.id === "openai/gpt-5.4");
      expect(gptModel).toBeDefined();
      expect(gptModel.context_length).toBe(128000);
      expect(gptModel.pricing.input_per_million).toBe(2.5);
      expect(gptModel.pricing.output_per_million).toBe(15.0);
      expect(gptModel.pricing.input_per_token).toBe(0.0000025);
    });
  });

  describe("POST /api/v1/chat/completions - Input Validation", () => {
    it("should return 400 Bad Request when model or messages are missing", async () => {
      const res1 = await request(server)
        .post("/api/v1/chat/completions")
        .send({});
      expect(res1.status).toBe(400);
      expect(res1.body?.error || res1.text).toContain("model");

      const res2 = await request(server)
        .post("/api/v1/chat/completions")
        .send({ model: "openai/gpt-5.4" });
      expect(res2.status).toBe(400);
      expect(res2.body?.error || res2.text).toContain("messages");
    });

    it("should return 400 Bad Request when unsupported model is requested", async () => {
      const res = await request(server)
        .post("/api/v1/chat/completions")
        .send({
          model: "unsupported-model-999",
          messages: [{ role: "user", content: "Hi" }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported model");
    });
  });

  describe("POST /api/v1/chat/completions - 402 Payment Required Challenge", () => {
    it("should return HTTP 402 with challenge headers and mirrored JSON body when no payment is provided", async () => {
      const reqBody = {
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "Hello! Tell me about MultiversX." }],
        max_tokens: 500,
      };

      const res = await request(server)
        .post("/api/v1/chat/completions")
        .send(reqBody);

      expect(res.status).toBe(402);

      // Check headers
      expect(res.headers["payment-required"]).toBeDefined();
      expect(res.headers["x-payment-required"]).toBeDefined();
      expect(res.headers["www-authenticate"]).toBeDefined();
      expect(res.headers["www-authenticate"]).toContain("x402 scheme=\"exact\"");

      // Check mirrored JSON body
      expect(res.body.x402Version).toBe(2);
      expect(res.body.error).toBe("Payment Required");
      expect(res.body.message).toBe("This endpoint requires x402 payment");
      expect(res.body.price).toBeDefined();
      expect(res.body.price.currency).toBe("USD");
      expect(res.body.price.amount).toBeDefined();
      expect(res.body.paymentInfo).toEqual({
        network: "multiversx",
        asset: "USDC",
        x402Version: 2,
      });

      expect(Array.isArray(res.body.accepts)).toBe(true);
      expect(res.body.accepts.length).toBe(1);

      const requirement: PaymentRequirements = res.body.accepts[0];
      expect(requirement.scheme).toBe("exact");
      expect(requirement.network).toBe("multiversx:1");
      expect(requirement.asset).toBe("USDC-c76f1f");
      expect(requirement.payTo).toBe(merchantAddress.toBech32());
      expect(requirement.maxTimeoutSeconds).toBe(300);
      expect(parseInt(requirement.amount, 10)).toBeGreaterThan(1000); // 1000 flat fee + token cost

      // Verify decoded header matches requirement
      const decodedReqHeader = decodeHeaderJson<PaymentRequirements>(res.headers["x-payment-required"]);
      expect(decodedReqHeader.amount).toBe(requirement.amount);
      expect(decodedReqHeader.payTo).toBe(merchantAddress.toBech32());
    });
  });

  describe("POST /api/v1/chat/completions - Payment Verification Failure", () => {
    it("should reject payment with corrupted signature and return 402 with structured error", async () => {
      // 1. Get challenge requirement
      const challengeRes = await request(server)
        .post("/api/v1/chat/completions")
        .send({
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: "Explain ESDT tokens" }],
        });
      expect(challengeRes.status).toBe(402);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      // 2. Sign with corrupted signature
      const corruptedPayload = await createPaymentPayload(requirement, { corruptSignature: true });
      const encodedPayload = encodeHeaderJson(corruptedPayload);

      // 3. Retry with PAYMENT-SIGNATURE
      const retryRes = await request(server)
        .post("/api/v1/chat/completions")
        .set("PAYMENT-SIGNATURE", encodedPayload)
        .send({
          model: "deepseek/deepseek-chat",
          messages: [{ role: "user", content: "Explain ESDT tokens" }],
        });

      expect(retryRes.status).toBe(402);
      expect(retryRes.body.error).toBe("Payment verification failed");
      expect(retryRes.body.code).toBeDefined();
      expect(retryRes.headers["x-payment-settled"]).toBe("false");
    });

    it("should reject payment with insufficient amount", async () => {
      const challengeRes = await request(server)
        .post("/api/v1/chat/completions")
        .send({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Write a compiler in Rust" }],
          max_tokens: 1000,
        });
      expect(challengeRes.status).toBe(402);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      // Underpay by specifying amount of only 1 micro-USDC
      const underpaidPayload = await createPaymentPayload(requirement, { tamperAmount: "1" });
      const encodedPayload = encodeHeaderJson(underpaidPayload);

      const retryRes = await request(server)
        .post("/api/v1/chat/completions")
        .set("PAYMENT-SIGNATURE", encodedPayload)
        .send({
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Write a compiler in Rust" }],
          max_tokens: 1000,
        });

      expect(retryRes.status).toBe(402);
      expect(retryRes.body.error).toBe("Payment verification failed");
    });
  });

  describe("POST /api/v1/chat/completions - Successful Payment Flow (x402 v2)", () => {
    it("should complete 402 challenge -> sign Relayed V3 -> 200 OK with OpenAI chat completion and receipt", async () => {
      const reqBody = {
        model: "openai/gpt-5.4",
        messages: [
          { role: "system", content: "You are an expert MultiversX developer." },
          { role: "user", content: "How do I implement x402 payments?" },
        ],
        max_tokens: 250,
      };

      // Step 1: Initial request -> 402 Payment Required
      const challengeRes = await request(server)
        .post("/api/v1/chat/completions")
        .send(reqBody);

      expect(challengeRes.status).toBe(402);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      // Step 2: Sign Relayed V3 transaction for required exact amount
      const validPayload = await createPaymentPayload(requirement);
      const encodedPayload = encodeHeaderJson(validPayload);

      // Step 3: Retry request with PAYMENT-SIGNATURE header
      const completionRes = await request(server)
        .post("/api/v1/chat/completions")
        .set("PAYMENT-SIGNATURE", encodedPayload)
        .send(reqBody);

      // Step 4: Verify 200 OK with standard OpenAI response format and settlement receipt headers
      expect(completionRes.status).toBe(200);
      expect(completionRes.headers["x-payment-settled"]).toBe("true");
      expect(completionRes.headers["x-payment-receipt"]).toBeDefined();
      expect(completionRes.headers["payment-response"]).toBeDefined();

      expect(completionRes.body.object).toBe("chat.completion");
      expect(completionRes.body.id).toMatch(/^chatcmpl-/);
      expect(completionRes.body.model).toBe("openai/gpt-5.4");
      expect(Array.isArray(completionRes.body.choices)).toBe(true);
      expect(completionRes.body.choices[0].message.role).toBe("assistant");
      expect(completionRes.body.choices[0].message.content).toBeDefined();
      expect(completionRes.body.usage).toBeDefined();
      expect(completionRes.body.usage.total_tokens).toBeGreaterThan(0);
    });

    it("should accept payment via X-Payment header", async () => {
      const reqBody = {
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "Hello DeepSeek!" }],
      };

      const challengeRes = await request(server)
        .post("/api/v1/chat/completions")
        .send(reqBody);
      expect(challengeRes.status).toBe(402);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      const validPayload = await createPaymentPayload(requirement);
      const encodedPayload = encodeHeaderJson(validPayload);

      const res = await request(server)
        .post("/api/v1/chat/completions")
        .set("X-Payment", encodedPayload)
        .send(reqBody);

      expect(res.status).toBe(200);
      expect(res.headers["x-payment-settled"]).toBe("true");
      expect(res.body.model).toBe("deepseek/deepseek-chat");
    });

    it("should accept payment via Authorization Bearer header", async () => {
      const reqBody = {
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: "Hello Gemini!" }],
      };

      const challengeRes = await request(server)
        .post("/api/v1/chat/completions")
        .send(reqBody);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      const validPayload = await createPaymentPayload(requirement);
      const encodedPayload = encodeHeaderJson(validPayload);

      const res = await request(server)
        .post("/api/v1/chat/completions")
        .set("Authorization", `Bearer ${encodedPayload}`)
        .send(reqBody);

      expect(res.status).toBe(200);
      expect(res.headers["x-payment-settled"]).toBe("true");
    });
  });

  describe("POST /api/v1/messages - Anthropic Compatible Endpoint", () => {
    it("should return 402 challenge when no payment is provided", async () => {
      const reqBody = {
        model: "anthropic/claude-sonnet-4.6",
        system: "You are Claude, an AI created by Anthropic.",
        messages: [{ role: "user", content: "Hello Claude Sonnet!" }],
        max_tokens: 500,
      };

      const res = await request(server)
        .post("/api/v1/messages")
        .send(reqBody);

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();
      expect(res.body.accepts[0].payTo).toBe(merchantAddress.toBech32());
    });

    it("should return 200 OK with Anthropic messages schema upon valid payment", async () => {
      const reqBody = {
        model: "anthropic/claude-sonnet-4.6",
        system: "You are Claude.",
        messages: [{ role: "user", content: "Explain MultiversX smart contracts" }],
        max_tokens: 400,
      };

      // 1. Challenge
      const challengeRes = await request(server)
        .post("/api/v1/messages")
        .send(reqBody);
      expect(challengeRes.status).toBe(402);
      const requirement: PaymentRequirements = challengeRes.body.accepts[0];

      // 2. Sign
      const validPayload = await createPaymentPayload(requirement);
      const encodedPayload = encodeHeaderJson(validPayload);

      // 3. Complete
      const res = await request(server)
        .post("/api/v1/messages")
        .set("PAYMENT-SIGNATURE", encodedPayload)
        .send(reqBody);

      expect(res.status).toBe(200);
      expect(res.headers["x-payment-settled"]).toBe("true");
      expect(res.headers["x-payment-receipt"]).toBeDefined();

      expect(res.body.type).toBe("message");
      expect(res.body.role).toBe("assistant");
      expect(res.body.model).toBe("anthropic/claude-sonnet-4.6");
      expect(Array.isArray(res.body.content)).toBe(true);
      expect(res.body.content[0].type).toBe("text");
      expect(res.body.content[0].text).toContain("Claude Sonnet 4.6");
      expect(res.body.usage).toBeDefined();
      expect(res.body.usage.input_tokens).toBeGreaterThan(0);
      expect(res.body.usage.output_tokens).toBeGreaterThan(0);
    });
  });

  describe("Custom Upstream AI Handler & Rate Limiting", () => {
    it("should delegate inference to custom upstreamAiHandler when configured", async () => {
      const customApp = createBlockRunGateway({
        verifier,
        settlementQueue,
        payTo: merchantAddress.toBech32(),
        rateLimit: { enabled: false },
        upstreamAiHandler: async (body) => ({
          id: "custom-completion-42",
          object: "chat.completion",
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Custom Upstream Response 🚀" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      });

      const customServer = customApp.listen(0, "127.0.0.1");
      try {
        const reqBody = {
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Hello upstream!" }],
        };

        const challenge = await request(customServer).post("/api/v1/chat/completions").send(reqBody);
        expect(challenge.status).toBe(402);
        const payload = await createPaymentPayload(challenge.body.accepts[0]);

        const res = await request(customServer)
          .post("/api/v1/chat/completions")
          .set("PAYMENT-SIGNATURE", encodeHeaderJson(payload))
          .send(reqBody);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe("custom-completion-42");
        expect(res.body.choices[0].message.content).toBe("Custom Upstream Response 🚀");
      } finally {
        await new Promise<void>((r) => customServer.close(() => r()));
      }
    });

    it("should timeout if upstreamAiHandler takes longer than upstreamTimeoutMs", async () => {
      const slowApp = createBlockRunGateway({
        verifier,
        settlementQueue,
        payTo: merchantAddress.toBech32(),
        upstreamTimeoutMs: 50,
        rateLimit: { enabled: false },
        upstreamAiHandler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { id: "never-reached" };
        },
      });

      const slowServer = slowApp.listen(0, "127.0.0.1");
      try {
        const reqBody = {
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Hello slow upstream!" }],
        };

        const challenge = await request(slowServer).post("/api/v1/chat/completions").send(reqBody);
        expect(challenge.status).toBe(402);
        const payload = await createPaymentPayload(challenge.body.accepts[0]);

        const res = await request(slowServer)
          .post("/api/v1/chat/completions")
          .set("PAYMENT-SIGNATURE", encodeHeaderJson(payload))
          .send(reqBody);

        expect(res.status).toBe(504);
        expect(res.body.error).toContain("timed out");
      } finally {
        await new Promise<void>((r) => slowServer.close(() => r()));
      }
    });

    it("should rate limit requests when limit is exceeded", async () => {
      const rateLimitedApp = createBlockRunGateway({
        verifier,
        settlementQueue,
        payTo: merchantAddress.toBech32(),
        rateLimit: { windowMs: 10000, max: 2, enabled: true },
      });

      const rlServer = rateLimitedApp.listen(0, "127.0.0.1");
      try {
        const res1 = await request(rlServer).get("/health");
        expect(res1.status).toBe(200);

        const res2 = await request(rlServer).get("/health");
        expect(res2.status).toBe(200);

        const res3 = await request(rlServer).get("/health");
        expect(res3.status).toBe(429);
        expect(res3.body.error).toContain("Too many requests");
      } finally {
        await new Promise<void>((r) => rlServer.close(() => r()));
      }
    });

    it("should support SSE streaming on /api/v1/chat/completions when stream: true", async () => {
      const reqBody = {
        model: "openai/gpt-5.4",
        messages: [{ role: "user", content: "Tell me a short poem" }],
        stream: true,
      };

      // 1. Unpaid request receives 402 challenge
      const challenge = await request(server).post("/api/v1/chat/completions").send(reqBody);
      expect(challenge.status).toBe(402);
      expect(challenge.body.accepts).toBeDefined();

      // 2. Sign payment and request with stream: true
      const payload = await createPaymentPayload(challenge.body.accepts[0]);
      const res = await request(server)
        .post("/api/v1/chat/completions")
        .set("PAYMENT-SIGNATURE", encodeHeaderJson(payload))
        .send(reqBody);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.headers["x-payment-receipt"]).toBeDefined();
      expect(res.text).toContain("data: ");
      expect(res.text).toContain("[DONE]");
    });

    it("should support SSE streaming on /api/v1/messages for Anthropic when stream: true", async () => {
      const reqBody = {
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "Hello streaming Claude" }],
        stream: true,
      };

      const challenge = await request(server).post("/api/v1/messages").send(reqBody);
      expect(challenge.status).toBe(402);

      const payload = await createPaymentPayload(challenge.body.accepts[0]);
      const res = await request(server)
        .post("/api/v1/messages")
        .set("PAYMENT-SIGNATURE", encodeHeaderJson(payload))
        .send(reqBody);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.headers["x-payment-receipt"]).toBeDefined();
      expect(res.text).toContain("event: message_start");
      expect(res.text).toContain("event: content_block_delta");
      expect(res.text).toContain("event: message_stop");
    });

    it("should pass AbortSignal to upstream AI handler and trigger on timeout", async () => {
      let receivedSignal: AbortSignal | undefined;
      const abortableApp = createBlockRunGateway({
        verifier,
        settlementQueue,
        payTo: merchantAddress.toBech32(),
        upstreamTimeoutMs: 50,
        rateLimit: { enabled: false },
        upstreamAiHandler: async (_req, signal) => {
          receivedSignal = signal;
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { content: "Done" };
        },
      });

      const abortServer = abortableApp.listen(0, "127.0.0.1");
      try {
        const reqBody = {
          model: "openai/gpt-5.4",
          messages: [{ role: "user", content: "Test signal" }],
        };

        const challenge = await request(abortServer).post("/api/v1/chat/completions").send(reqBody);
        const payload = await createPaymentPayload(challenge.body.accepts[0]);

        const res = await request(abortServer)
          .post("/api/v1/chat/completions")
          .set("PAYMENT-SIGNATURE", encodeHeaderJson(payload))
          .send(reqBody);

        expect(res.status).toBe(504);
        expect(receivedSignal).toBeDefined();
        expect(receivedSignal?.aborted).toBe(true);
      } finally {
        await new Promise<void>((r) => abortServer.close(() => r()));
      }
    });
  });
});
