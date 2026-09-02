import { describe, it, expect, beforeEach, vi } from "vitest";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { BlockRunMvxClient, setupAgentWallet } from "../../src/client/blockrun_mvx_client.js";
import { PaymentError, SpendLimitError, APIError } from "../../src/client/errors.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { PaymentRequirements, X402PaymentPayload } from "../../src/domain/types.js";
import { encodeHeaderJson } from "../../src/utils/header_utils.js";
import { buildEsdtTransferData } from "../../src/utils/data_parser.js";

describe("BlockRunMvxClient SDK", () => {
  let agentMnemonic: Mnemonic;
  let agentSigner: UserSigner;
  let agentAddress: Address;

  let merchantMnemonic: Mnemonic;
  let merchantSigner: UserSigner;
  let merchantAddress: Address;

  let relayerMnemonic: Mnemonic;
  let relayerSigner: UserSigner;
  let relayerAddress: Address;

  let mockNetworkProvider: INetworkProvider;
  let mockFetch: any;

  beforeEach(() => {
    agentMnemonic = Mnemonic.generate();
    agentSigner = new UserSigner(agentMnemonic.deriveKey(0));
    agentAddress = Address.newFromBech32(agentSigner.getAddress().bech32());

    merchantMnemonic = Mnemonic.generate();
    merchantSigner = new UserSigner(merchantMnemonic.deriveKey(0));
    merchantAddress = Address.newFromBech32(merchantSigner.getAddress().bech32());

    relayerMnemonic = Mnemonic.generate();
    relayerSigner = new UserSigner(relayerMnemonic.deriveKey(0));
    relayerAddress = Address.newFromBech32(relayerSigner.getAddress().bech32());

    mockNetworkProvider = {
      simulateTransaction: vi.fn().mockResolvedValue({ status: "success", returnCode: "ok" }),
      sendTransaction: vi.fn().mockResolvedValue("tx-hash-12345"),
      getTransaction: vi.fn().mockResolvedValue({ status: "success" }),
      getAccount: vi.fn().mockResolvedValue({ nonce: 5, balance: "1000000000000000000" }),
    };
  });

  describe("Wallet Initialization & Setup", () => {
    it("should initialize client from UserSigner instance", () => {
      const client = new BlockRunMvxClient({
        signer: agentSigner,
        gatewayUrl: "https://api.blockrun.ai",
        network: "multiversx:1",
      });

      expect(client.getWalletAddress()).toBe(agentAddress.toBech32());
      expect(client.getSessionSpend()).toBe(0);
    });

    it("should initialize client from mnemonic string", () => {
      const client = new BlockRunMvxClient({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: "https://api.blockrun.ai",
      });

      expect(client.getWalletAddress()).toBe(agentAddress.toBech32());
    });

    it("should setup agent wallet via setupAgentWallet helper", () => {
      const client = setupAgentWallet({
        mnemonic: agentMnemonic.toString(),
        gatewayUrl: "https://custom-gateway.io",
      });

      expect(client).toBeInstanceOf(BlockRunMvxClient);
      expect(client.getWalletAddress()).toBe(agentAddress.toBech32());
    });

    it("should retrieve account balance through network provider", async () => {
      const client = new BlockRunMvxClient({
        signer: agentSigner,
        networkProvider: mockNetworkProvider,
      });

      const balance = await client.getBalance();
      expect(balance).toBe("1000000000000000000");
    });
  });

  describe("Autonomous 402 Payment Loop", () => {
    it("should return immediate 200 response when no payment is required", async () => {
      const mockResponse = {
        id: "chatcmpl-free",
        choices: [{ message: { role: "assistant", content: "Free response" } }],
      };

      const customFetch = vi.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockResponse,
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
      });

      const res = await client.chat("openai/gpt-5.4", "Hello world");
      expect(res.id).toBe("chatcmpl-free");
      expect(res.choices[0].message.content).toBe("Free response");
      expect(client.getSessionSpend()).toBe(0);
    });

    it("should autonomously handle 402 challenge -> sign Relayed V3 -> retry -> return response with receipt", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "5000", // 0.005 USDC = 5000 micro-USDC
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
        price: { amount: "0.005000", currency: "USD" },
      };

      const mockCompletion = {
        id: "chatcmpl-paid-1",
        choices: [{ message: { role: "assistant", content: "Autonomous AI Output" } }],
      };

      let callCount = 0;
      const customFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        callCount++;
        if (callCount === 1) {
          // 402 challenge
          return {
            status: 402,
            ok: false,
            headers: new Headers({
              "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody),
              "content-type": "application/json",
            }),
            json: async () => challengeBody,
          };
        }
        if (url.includes("/relayer/address/")) {
          // Relayer resolution
          return {
            status: 200,
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              relayerAddress: relayerAddress.toBech32(),
              shard: 1,
            }),
          };
        }
        // Second call with PAYMENT-SIGNATURE
        expect(opts.headers["PAYMENT-SIGNATURE"]).toBeDefined();
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            "content-type": "application/json",
            "x-payment-receipt": "tx-hash-settled-12345",
            "x-payment-settled": "true",
          }),
          json: async () => mockCompletion,
        };
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
        relayerAddress: relayerAddress.toBech32(),
      });

      const res = await client.chat("openai/gpt-5.4", [{ role: "user", content: "Solve math" }]);
      expect(res.id).toBe("chatcmpl-paid-1");
      expect(res.paymentReceipt).toBe("tx-hash-settled-12345");
      expect(client.getSessionSpend()).toBeCloseTo(0.005, 6);
    });

    it("should support messages() Anthropic endpoint format", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "3000",
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
      };

      const mockAnthropicResp = {
        id: "msg_anthropic_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Claude response" }],
      };

      let callCount = 0;
      const customFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 402,
            ok: false,
            headers: new Headers({
              "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody),
            }),
            json: async () => challengeBody,
          };
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            "content-type": "application/json",
            "x-payment-receipt": "tx-anthropic-receipt",
          }),
          json: async () => mockAnthropicResp,
        };
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
        relayerAddress: relayerAddress.toBech32(),
      });

      const res = await client.messages("anthropic/claude-sonnet-4.6", [
        { role: "user", content: "Write a poem" },
      ]);

      expect(res.id).toBe("msg_anthropic_123");
      expect(res.content[0].text).toBe("Claude response");
      expect(res.paymentReceipt).toBe("tx-anthropic-receipt");
      expect(client.getSessionSpend()).toBeCloseTo(0.003, 6);
    });

    it("should stream chat completion chunks via chatStream", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "1000",
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
      };

      const sseText =
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"World!"}}]}\n\n' +
        "data: [DONE]\n\n";

      let callCount = 0;
      const customFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 402,
            ok: false,
            headers: new Headers({ "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody) }),
            json: async () => challengeBody,
          };
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers({
            "content-type": "text/event-stream",
            "x-payment-receipt": "tx-stream-receipt-123",
          }),
          text: async () => sseText,
        };
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
        relayerAddress: relayerAddress.toBech32(),
      });

      const chunks: string[] = [];
      const stream = client.chatStream("openai/gpt-5.4", "Hi streaming");
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(["Hello ", "World!"]);
    });
  });

  describe("Spend Limits Protection", () => {
    it("should throw SpendLimitError when cost exceeds maxCostPerCall", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "100000", // $0.10
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
      };

      const customFetch = vi.fn().mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers({ "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody) }),
        json: async () => challengeBody,
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        maxCostPerCall: 0.05, // $0.05 limit
      });

      await expect(client.chat("openai/gpt-5.4", "Expensive query")).rejects.toThrow(
        SpendLimitError
      );
      expect(client.getSessionSpend()).toBe(0);
    });

    it("should throw SpendLimitError when total session spend exceeds maxSessionCost", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "20000", // $0.02
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
      };

      const mockCompletion = {
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: "Output" } }],
      };

      // 1st call: $0.02 (OK)
      // 2nd call: $0.02 (Exceeds $0.03 total maxSessionCost)
      let callCount = 0;
      const customFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 1) {
          return {
            status: 402,
            ok: false,
            headers: new Headers({ "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody) }),
            json: async () => challengeBody,
          };
        }
        return {
          status: 200,
          ok: true,
          headers: new Headers({ "x-payment-receipt": "tx-receipt" }),
          json: async () => mockCompletion,
        };
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
        relayerAddress: relayerAddress.toBech32(),
        maxSessionCost: 0.03, // $0.03 session limit
      });

      // Call 1 -> passes ($0.02 spend)
      await client.chat("openai/gpt-5.4", "Call 1");
      expect(client.getSessionSpend()).toBeCloseTo(0.02, 6);

      // Call 2 -> fails (would be $0.04 > $0.03)
      await expect(client.chat("openai/gpt-5.4", "Call 2")).rejects.toThrow(
        SpendLimitError
      );
      expect(client.getSessionSpend()).toBeCloseTo(0.02, 6);
    });
  });

  describe("Smart Routing (smartChat)", () => {
    it("should route simple query to eco tier model with estimated savings", async () => {
      const mockCompletion = {
        id: "chatcmpl-eco",
        model: "deepseek/deepseek-chat",
        choices: [{ message: { role: "assistant", content: "Eco answer" } }],
      };

      const customFetch = vi.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockCompletion,
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
      });

      const result = await client.smartChat("What is 2+2?", "eco");
      expect(result.id).toBe("chatcmpl-eco");
      expect(result.routing.tier).toBe("eco");
      expect(result.routing.savings).toBeDefined();
    });

    it("should route complex coding prompt to premium tier model", async () => {
      const mockCompletion = {
        id: "chatcmpl-premium",
        model: "openai/gpt-5.4",
        choices: [{ message: { role: "assistant", content: "Premium response" } }],
      };

      const customFetch = vi.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => mockCompletion,
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
      });

      const complexPrompt = "Write a complete Rust smart contract for MultiversX ESDT token transfer with Relayed V3 verification and prove memory safety.";
      const result = await client.smartChat(complexPrompt, "auto");

      expect(result.id).toBe("chatcmpl-premium");
      expect(result.routing.tier).toBe("premium");
    });
  });

  describe("Error Handling", () => {
    it("should throw APIError on 500 or 400 server failure", async () => {
      const customFetch = vi.fn().mockResolvedValueOnce({
        status: 500,
        ok: false,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: "Internal Server Error" }),
        text: async () => JSON.stringify({ error: "Internal Server Error" }),
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
      });

      await expect(client.chat("openai/gpt-5.4", "Query")).rejects.toThrow(APIError);
    });

    it("should throw PaymentError when retry after payment returns non-200", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "multiversx:1",
        amount: "1000",
        asset: "USDC-c76f1f",
        payTo: merchantAddress.toBech32(),
        maxTimeoutSeconds: 300,
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [requirements],
      };

      let callCount = 0;
      const customFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 402,
            ok: false,
            headers: new Headers({ "PAYMENT-REQUIRED": encodeHeaderJson(challengeBody) }),
            json: async () => challengeBody,
          };
        }
        return {
          status: 402,
          ok: false,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "Payment verification failed", code: "PAYMENT_INVALID" }),
          text: async () => JSON.stringify({ error: "Payment verification failed" }),
        };
      });

      const client = new BlockRunMvxClient({
        signer: agentSigner,
        fetch: customFetch,
        networkProvider: mockNetworkProvider,
        relayerAddress: relayerAddress.toBech32(),
      });

      await expect(client.chat("openai/gpt-5.4", "Query")).rejects.toThrow(PaymentError);
    });
  });
});
