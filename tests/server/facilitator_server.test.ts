import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import http from "http";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import {
  PaymentErrorCode,
  PaymentRequirements,
  SettleRequest,
  VerifyRequest,
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
import { createFacilitatorServer } from "../../src/server/facilitator_server.js";
import { Express } from "express";

describe("Facilitator HTTP Server (x402 v2 Endpoints & OpenAPI)", () => {
  let app: Express;
  let server: http.Server;
  let userMnemonic: Mnemonic;
  let userSigner: UserSigner;
  let userAddress: Address;

  let receiverMnemonic: Mnemonic;
  let receiverSigner: UserSigner;
  let receiverAddress: Address;

  let relayerPool: RelayerPoolManager;
  let verifier: VerifierService;
  let settler: SettlerService;
  let settlementQueue: SettlementQueue;
  let storage: MemorySettlementStorage;
  let broadcastedTxs: Transaction[];
  let tc: TransactionComputer;

  const standardRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "multiversx:1",
    asset: "USDC-c76f1f",
    amount: "1000000",
    payTo: "", // Will be assigned in beforeEach
    maxTimeoutSeconds: 300,
  };

  async function createValidPaymentPayload(
    options?: {
      amount?: string;
      asset?: string;
      validBefore?: number;
      validAfter?: number;
      corruptSignature?: boolean;
    }
  ): Promise<X402PaymentPayload> {
    const amount = options?.amount ?? standardRequirements.amount;
    const asset = options?.asset ?? standardRequirements.asset;
    const relayerAddrStr = relayerPool.getRelayerAddressForUser(userAddress.toBech32());

    const tx = new Transaction({
      nonce: 1n,
      value: 0n,
      sender: userAddress,
      receiver: receiverAddress,
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
        url: "https://api.blockrun.ai/v1/compute",
        description: "AI Inference Payment",
      },
      accepted: {
        ...standardRequirements,
        asset,
        amount,
      },
      payload: {
        nonce: 1,
        value: "0",
        receiver: receiverAddress.toBech32(),
        sender: userAddress.toBech32(),
        gasPrice: 1000000000,
        gasLimit: 500000,
        data: buildEsdtTransferData(asset, amount),
        chainID: "1",
        version: 2,
        options: 0,
        signature: sigHex,
        relayer: relayerAddrStr,
        validBefore: options?.validBefore,
        validAfter: options?.validAfter,
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

    receiverMnemonic = Mnemonic.generate();
    receiverSigner = new UserSigner(receiverMnemonic.deriveKey(0));
    receiverAddress = Address.newFromBech32(receiverSigner.getAddress().bech32());
    standardRequirements.payTo = receiverAddress.toBech32();

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

    app = createFacilitatorServer({
      verifier,
      settlementQueue,
      relayerPool,
      supportedNetworks: ["multiversx:1", "multiversx:D", "multiversx:T"],
      extensions: ["bazaar", "relayed-v3"],
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
    it("should return 200 with status ok, timestamp, version, and queue stats", async () => {
      const res = await request(server).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.version).toBe("2.0.0");
      expect(typeof res.body.timestamp).toBe("string");
      expect(res.body.queueStats).toBeDefined();
      expect(res.body.pendingCount).toBe(0);
    });
  });

  describe("GET /supported", () => {
    it("should return supported kinds, extensions, and signers for networks", async () => {
      const res = await request(server).get("/supported");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.kinds)).toBe(true);
      expect(res.body.kinds.length).toBeGreaterThan(0);
      expect(res.body.extensions).toEqual(["bazaar", "relayed-v3"]);
      expect(res.body.signers).toBeDefined();
      expect(Array.isArray(res.body.signers["multiversx:1"])).toBe(true);
    });
  });

  describe("GET /.well-known/x402", () => {
    it("should return complete discovery document with x402 metadata and endpoints", async () => {
      const res = await request(server).get("/.well-known/x402");
      expect(res.status).toBe(200);
      expect(res.body.x402Version).toBe(2);
      expect(res.body.name).toBe("BlockRun MultiversX x402 Facilitator Gateway");
      expect(res.body.endpoints).toBeDefined();
      expect(res.body.endpoints.verify).toBe("/verify");
      expect(res.body.endpoints.settle).toBe("/settle");
      expect(res.body.endpoints.supported).toBe("/supported");
      expect(res.body.endpoints.health).toBe("/health");
      expect(res.body.endpoints.openapi).toBe("/openapi.json");
    });
  });

  describe("GET /relayer/address/:userAddress", () => {
    it("should return relayer address and shard for a valid user address", async () => {
      const userAddrStr = userAddress.toBech32();
      const res = await request(server).get(`/relayer/address/${userAddrStr}`);
      expect(res.status).toBe(200);
      expect(res.body.relayerAddress).toBe(relayerPool.getRelayerAddressForUser(userAddrStr));
      expect(typeof res.body.shard).toBe("number");
    });

    it("should return 400 for invalid MultiversX bech32 address", async () => {
      const res = await request(server).get("/relayer/address/invalid-address-not-bech32");
      expect(res.status).toBe(400);
      expect(res.text).toContain("Invalid MultiversX address");
    });
  });

  describe("GET /relayer/shards", () => {
    it("should return all configured relayer addresses by shard", async () => {
      const res = await request(server).get("/relayer/shards");
      expect(res.status).toBe(200);
      expect(res.body.relayers).toBeDefined();
      expect(Array.isArray(res.body.shards)).toBe(true);
      expect(res.body.shards.length).toBeGreaterThan(0);
    });
  });

  describe("POST /verify", () => {
    it("should verify a valid Relayed V3 payment payload and set PAYMENT-RESPONSE header", async () => {
      const paymentPayload = await createValidPaymentPayload();
      const verifyReq: VerifyRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res = await request(server).post("/verify").send(verifyReq);
      expect(res.status).toBe(200);
      expect(res.body.isValid).toBe(true);
      expect(res.body.payer).toBe(userAddress.toBech32());

      // Check header
      expect(res.headers["payment-response"]).toBeDefined();
      const headerDecoded = decodeHeaderJson(res.headers["payment-response"]);
      expect(headerDecoded).toEqual(res.body);
    });

    it("should return isValid: false for corrupted signature with PAYMENT_INVALID error code", async () => {
      const paymentPayload = await createValidPaymentPayload({ corruptSignature: true });
      const verifyReq: VerifyRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res = await request(server).post("/verify").send(verifyReq);
      expect(res.status).toBe(200);
      expect(res.body.isValid).toBe(false);
      expect(res.body.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    });

    it("should return isValid: false with PAYMENT_EXPIRED for expired payment", async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 60;
      const paymentPayload = await createValidPaymentPayload({ validBefore: pastTime });
      const verifyReq: VerifyRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res = await request(server).post("/verify").send(verifyReq);
      expect(res.status).toBe(200);
      expect(res.body.isValid).toBe(false);
      expect(res.body.errorCode).toBe(PaymentErrorCode.PAYMENT_EXPIRED);
    });

    it("should accept payment payload passed via PAYMENT-SIGNATURE header", async () => {
      const paymentPayload = await createValidPaymentPayload();
      const encoded = encodeHeaderJson(paymentPayload);

      const res = await request(server)
        .post("/verify")
        .set("PAYMENT-SIGNATURE", encoded)
        .send({ paymentRequirements: standardRequirements });

      expect(res.status).toBe(200);
      expect(res.body.isValid).toBe(true);
    });

    it("should return 400 Bad Request on invalid request schema", async () => {
      const res = await request(server)
        .post("/verify")
        .send({ invalid: "data", missingRequirements: true });

      expect(res.status).toBe(400);
      expect(res.text).toContain("Invalid verify request");
    });
  });

  describe("POST /settle", () => {
    it("should settle valid payment and return receipt headers", async () => {
      const paymentPayload = await createValidPaymentPayload();
      const settleReq: SettleRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res = await request(server).post("/settle").send(settleReq);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction).toBeDefined();
      expect(res.body.network).toBe("multiversx:1");
      expect(res.body.payer).toBe(userAddress.toBech32());

      // Check x402 headers
      expect(res.headers["x-payment-receipt"]).toBe(res.body.transaction);
      expect(res.headers["x-payment-settled"]).toBe("true");
      expect(res.headers["payment-response"]).toBeDefined();
      expect(broadcastedTxs.length).toBe(1);
    });

    it("should return idempotently when settling the exact same signature twice", async () => {
      const paymentPayload = await createValidPaymentPayload();
      const settleReq: SettleRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res1 = await request(server).post("/settle").send(settleReq);
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      const tx1 = res1.body.transaction;

      const res2 = await request(server).post("/settle").send(settleReq);
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.transaction).toBe(tx1);

      // Only 1 broadcast to network
      expect(broadcastedTxs.length).toBe(1);
    });

    it("should return success: false for invalid signature without broadcasting", async () => {
      const paymentPayload = await createValidPaymentPayload({ corruptSignature: true });
      const settleReq: SettleRequest = {
        paymentPayload,
        paymentRequirements: standardRequirements,
      };

      const res = await request(server).post("/settle").send(settleReq);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
      expect(res.headers["x-payment-settled"]).toBe("false");
      expect(broadcastedTxs.length).toBe(0);
    });

    it("should accept settle payload from PAYMENT-SIGNATURE header", async () => {
      const paymentPayload = await createValidPaymentPayload();
      const encoded = encodeHeaderJson(paymentPayload);

      const res = await request(server)
        .post("/settle")
        .set("payment-signature", encoded)
        .send({ paymentRequirements: standardRequirements });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction).toBeDefined();
    });

    it("should return 400 Bad Request on invalid request body", async () => {
      const res = await request(server).post("/settle").send({ foo: "bar" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("GET /openapi.json", () => {
    it("should return valid OpenAPI 3.1.0 document with all facilitator endpoints", async () => {
      const res = await request(server).get("/openapi.json");
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.1.0");
      expect(res.body.info).toBeDefined();
      expect(res.body.info.title).toContain("x402");
      expect(res.body.paths).toBeDefined();
      expect(res.body.paths["/verify"]).toBeDefined();
      expect(res.body.paths["/settle"]).toBeDefined();
      expect(res.body.paths["/supported"]).toBeDefined();
      expect(res.body.paths["/.well-known/x402"]).toBeDefined();
      expect(res.body.paths["/health"]).toBeDefined();
      expect(res.body.paths["/relayer/address/{userAddress}"]).toBeDefined();
      expect(res.body.paths["/relayer/shards"]).toBeDefined();
      expect(res.body.components?.schemas).toBeDefined();
    });
  });

  describe("Middleware & Error Handling", () => {
    it("should handle CORS pre-flight OPTIONS request and expose x402 headers", async () => {
      const res = await request(server)
        .options("/settle")
        .set("Origin", "https://app.blockrun.ai")
        .set("Access-Control-Request-Method", "POST");

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBeDefined();
    });

    it("should include security headers from helmet", async () => {
      const res = await request(server).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("should handle malformed JSON body with structured 400 error", async () => {
      const malformedApp = createFacilitatorServer({
        verifier,
        settlementQueue,
        rateLimit: { enabled: false },
      });
      const res = await request(malformedApp)
        .post("/verify")
        .set("Content-Type", "application/json")
        .set("Connection", "close")
        .send("{ malformed-json-payload ");

      expect(res.status).toBe(400);
      const parsed = res.body?.error ? res.body : JSON.parse(res.text || "{}");
      expect(parsed.error).toContain("Malformed JSON");
    });

    it("should rate limit requests when configured and limit is exceeded", async () => {
      const rateLimitedApp = createFacilitatorServer({
        verifier,
        settlementQueue,
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

    it("should gracefully handle missing relayer pool for relayer endpoints", async () => {
      const noRelayerApp = createFacilitatorServer({
        verifier,
        settlementQueue,
        rateLimit: { enabled: false },
      });

      const noRelayerServer = noRelayerApp.listen(0, "127.0.0.1");
      try {
        const resShards = await request(noRelayerServer).get("/relayer/shards");
        expect(resShards.status).toBe(200);
        expect(resShards.body.shards).toEqual([]);

        const resAddr = await request(noRelayerServer).get(`/relayer/address/${userAddress.toBech32()}`);
        expect(resAddr.status).toBe(503);
        expect(resAddr.body.error).toContain("not configured");
      } finally {
        await new Promise<void>((r) => noRelayerServer.close(() => r()));
      }
    });

    it("should configure trust proxy setting when provided", () => {
      const proxyApp = createFacilitatorServer({
        verifier,
        settlementQueue,
        trustProxy: true,
        rateLimit: { enabled: false },
      });
      expect(proxyApp.get("trust proxy")).toBe(true);
    });
  });
});

