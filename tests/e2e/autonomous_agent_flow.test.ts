import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { BlockRunMvxClient } from "../../src/client/blockrun_mvx_client.js";
import { SpendLimitError } from "../../src/client/errors.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { VerifierService } from "../../src/services/verifier.js";
import { SettlerService } from "../../src/services/settler.js";
import { SettlementQueue } from "../../src/services/settlement_queue.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";
import { createBlockRunGateway } from "../../src/gateway/blockrun_gateway.js";

describe("Autonomous Agent E2E Integration Suite (Client -> Gateway -> Settlement -> AI Output)", () => {
  let server: http.Server;
  let serverUrl: string;

  let merchantMnemonic: Mnemonic;
  let merchantSigner: UserSigner;
  let merchantAddress: Address;

  let relayerPool: RelayerPoolManager;
  let storage: MemorySettlementStorage;
  let verifier: VerifierService;
  let settler: SettlerService;
  let settlementQueue: SettlementQueue;
  let broadcastedTxs: Transaction[];

  let mockNetworkProvider: INetworkProvider;

  beforeEach(async () => {
    broadcastedTxs = [];
    storage = new MemorySettlementStorage();

    // Merchant wallet
    merchantMnemonic = Mnemonic.generate();
    merchantSigner = new UserSigner(merchantMnemonic.deriveKey(0));
    merchantAddress = Address.newFromBech32(merchantSigner.getAddress().bech32());

    // Relayer Pool (shards 0, 1, 2)
    const relayerMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString(), {
      maxScanIndex: 250,
    });

    // Mock blockchain network provider
    mockNetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      sendTransaction: async (tx: Transaction): Promise<string> => {
        broadcastedTxs.push(tx);
        return `tx-mvx-hash-${broadcastedTxs.length}-${Date.now()}`;
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
      baseDelayMs: 5,
    });

    const gatewayApp = createBlockRunGateway({
      verifier,
      settlementQueue,
      payTo: merchantAddress.toBech32(),
      network: "multiversx:1",
      asset: "USDC-c76f1f",
      rateLimit: { enabled: false },
    });

    // Start local HTTP server for real network interaction
    await new Promise<void>((resolve) => {
      server = gatewayApp.listen(0, "127.0.0.1", () => {
        const address = server.address() as any;
        serverUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  describe("Autonomous AI Inference & Payment Lifecycle", () => {
    it("should autonomously complete 402 challenge -> Relayed V3 signing -> settlement -> OpenAI response", async () => {
      const agentMnemonic = Mnemonic.generate();
      const client = new BlockRunMvxClient({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: serverUrl,
        networkProvider: mockNetworkProvider,
      });

      const response = await client.chat("openai/gpt-5.4", [
        { role: "system", content: "You are an autonomous AI agent." },
        { role: "user", content: "Summarize the x402 MultiversX payment protocol." },
      ]);

      // Verify AI completion output
      expect(response.id).toBeDefined();
      expect(response.choices).toBeDefined();
      expect(response.choices.length).toBeGreaterThan(0);
      expect(response.choices[0].message.content).toContain("MultiversX x402 payment settled");

      // Verify payment receipt
      expect(response.paymentReceipt).toBeDefined();
      expect(response.paymentReceipt?.startsWith("tx-mvx-hash-")).toBe(true);

      // Verify session spend was tracked
      expect(client.getSessionSpend()).toBeGreaterThan(0);

      // Verify transaction was broadcasted to network
      expect(broadcastedTxs.length).toBe(1);
      const broadcastedTx = broadcastedTxs[0];
      expect(broadcastedTx.sender.toBech32()).toBe(client.getWalletAddress());
      expect(broadcastedTx.relayer?.toBech32()).toBeDefined();
    });

    it("should autonomously execute Anthropic messages format with payment", async () => {
      const agentMnemonic = Mnemonic.generate();
      const client = new BlockRunMvxClient({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: serverUrl,
        networkProvider: mockNetworkProvider,
      });

      const response = await client.messages("anthropic/claude-sonnet-4.6", [
        { role: "user", content: "Explain micro-payments on MultiversX." },
      ]);

      expect(response.id).toBeDefined();
      expect(response.type).toBe("message");
      expect(response.content[0].text).toContain("MultiversX x402 payment settled");
      expect(response.paymentReceipt).toBeDefined();
      expect(client.getSessionSpend()).toBeGreaterThan(0);
      expect(broadcastedTxs.length).toBe(1);
    });

    it("should perform smartChat with autonomous routing and cost optimization", async () => {
      const agentMnemonic = Mnemonic.generate();
      const client = new BlockRunMvxClient({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: serverUrl,
        networkProvider: mockNetworkProvider,
      });

      // 1. Eco query
      const ecoRes = await client.smartChat("What is the speed of light in vacuum?", "eco");
      expect(ecoRes.routing.tier).toBe("eco");
      expect(ecoRes.routing.model).toBe("deepseek/deepseek-chat");
      expect(ecoRes.paymentReceipt).toBeDefined();

      // 2. Auto query with complex code request -> premium
      const premiumRes = await client.smartChat(
        "Write a complete Rust smart contract for MultiversX with Relayed V3 verification and proof of state integrity.",
        "auto"
      );
      expect(premiumRes.routing.tier).toBe("premium");
      expect(premiumRes.routing.model).toBe("openai/gpt-5.4");
      expect(premiumRes.paymentReceipt).toBeDefined();

      expect(broadcastedTxs.length).toBe(2);
    });
  });

  describe("Spend Limits & Security Guardrails", () => {
    it("should halt execution and protect agent funds if cost exceeds maxCostPerCall", async () => {
      const agentMnemonic = Mnemonic.generate();
      const client = new BlockRunMvxClient({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: serverUrl,
        networkProvider: mockNetworkProvider,
        maxCostPerCall: 0.0001, // $0.0001 limit (gateway charges ~$0.002)
      });

      await expect(
        client.chat("openai/gpt-5.4", "Generate extensive analysis")
      ).rejects.toThrow(SpendLimitError);

      // No blockchain transaction broadcasted
      expect(broadcastedTxs.length).toBe(0);
      expect(client.getSessionSpend()).toBe(0);
    });
  });

  describe("Multi-Agent Concurrency & Shard Relayer Distribution", () => {
    it("should process concurrent requests from multiple agents on different shards without collision", async () => {
      const agentCount = 5;
      const agents: BlockRunMvxClient[] = [];

      for (let i = 0; i < agentCount; i++) {
        const mn = Mnemonic.generate();
        agents.push(
          new BlockRunMvxClient({
            mnemonic: mn.toString(),
            gatewayUrl: serverUrl,
            networkProvider: mockNetworkProvider,
          })
        );
      }

      // Execute all 5 agent requests concurrently
      const promises = agents.map((agent, index) =>
        agent.chat("deepseek/deepseek-chat", `Concurrent agent query #${index + 1}`)
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(agentCount);
      for (const res of results) {
        expect(res.choices[0].message.content).toBeDefined();
        expect(res.paymentReceipt).toBeDefined();
      }

      // All 5 transactions settled
      expect(broadcastedTxs.length).toBe(agentCount);

      // All senders distinct
      const senderAddresses = new Set(broadcastedTxs.map((tx) => tx.sender.toBech32()));
      expect(senderAddresses.size).toBe(agentCount);
    });
  });

  describe("Custom Upstream AI Model Execution", () => {
    it("should delegate to custom upstream AI handler upon valid payment", async () => {
      const customGatewayApp = createBlockRunGateway({
        verifier,
        settlementQueue,
        payTo: merchantAddress.toBech32(),
        network: "multiversx:1",
        upstreamAiHandler: async (body) => ({
          id: "custom-ai-model-id",
          object: "chat.completion",
          created: 1234567890,
          model: (body as any).model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Custom Fine-Tuned Agent Model Output" },
              finish_reason: "stop",
            },
          ],
        }),
      });

      let customServer: http.Server;
      let customServerUrl: string;

      await new Promise<void>((resolve) => {
        customServer = customGatewayApp.listen(0, "127.0.0.1", () => {
          const address = customServer.address() as any;
          customServerUrl = `http://127.0.0.1:${address.port}`;
          resolve();
        });
      });

      try {
        const agentMnemonic = Mnemonic.generate();
        const client = new BlockRunMvxClient({
          mnemonic: agentMnemonic.toString(),
          gatewayUrl: customServerUrl,
          networkProvider: mockNetworkProvider,
        });

        const res = await client.chat("openai/gpt-5.4", "Hello custom engine");
        expect(res.id).toBe("custom-ai-model-id");
        expect(res.choices[0].message.content).toBe("Custom Fine-Tuned Agent Model Output");
        expect(res.paymentReceipt).toBeDefined();
      } finally {
        await new Promise<void>((resolve, reject) => {
          customServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });
});
