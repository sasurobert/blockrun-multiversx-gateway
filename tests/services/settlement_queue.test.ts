import { describe, it, expect, beforeEach, vi } from "vitest";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { PaymentErrorCode, SettleRequest, SettleResponse } from "../../src/domain/types.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { RelayerPoolManager, METACHAIN_SHARD_ID } from "../../src/services/relayer_pool.js";
import { SettlerService, ISettlerService } from "../../src/services/settler.js";
import { SettlementQueue } from "../../src/services/settlement_queue.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";

describe("SettlementQueue (High-Throughput Shard-Partitioned Queue)", () => {
  let userMnemonic: Mnemonic;
  let userSigner: UserSigner;
  let userAddress: Address;

  let receiverMnemonic: Mnemonic;
  let receiverSigner: UserSigner;
  let receiverAddress: Address;

  let relayerPool: RelayerPoolManager;
  let memoryStorage: MemorySettlementStorage;
  let tc: TransactionComputer;

  let mockNetworkProvider: INetworkProvider;
  let broadcastCount: number;

  beforeEach(() => {
    tc = new TransactionComputer();
    memoryStorage = new MemorySettlementStorage();
    broadcastCount = 0;

    userMnemonic = Mnemonic.generate();
    userSigner = new UserSigner(userMnemonic.deriveKey(0));
    userAddress = Address.newFromBech32(userSigner.getAddress().bech32());

    receiverMnemonic = Mnemonic.generate();
    receiverSigner = new UserSigner(receiverMnemonic.deriveKey(0));
    receiverAddress = Address.newFromBech32(receiverSigner.getAddress().bech32());

    const relayerMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString(), {
      shardsToCover: [0, 1, 2],
    });

    mockNetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      sendTransaction: async (): Promise<string> => {
        broadcastCount++;
        return `0xhash${broadcastCount}`;
      },
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };
  });

  async function createSettleRequest(params?: {
    signer?: UserSigner;
    nonce?: bigint;
    amount?: string;
    asset?: string;
  }): Promise<SettleRequest> {
    const signer = params?.signer ?? userSigner;
    const sender = Address.newFromBech32(signer.getAddress().bech32());
    const amount = params?.amount ?? "1000000000000000000";
    const asset = params?.asset ?? "EGLD";

    const tx = new Transaction({
      nonce: params?.nonce ?? 0n,
      value: BigInt(amount),
      sender: sender,
      receiver: receiverAddress,
      gasPrice: 1000000000n,
      gasLimit: 70000n,
      data: Buffer.from(""),
      chainID: "D",
      version: 1,
      options: 0,
    });

    const bytes = tc.computeBytesForSigning(tx);
    const sig = await signer.sign(bytes);

    const txPayload = {
      nonce: Number(tx.nonce),
      value: tx.value.toString(),
      receiver: tx.receiver.toBech32(),
      sender: tx.sender.toBech32(),
      gasPrice: Number(tx.gasPrice),
      gasLimit: Number(tx.gasLimit),
      chainID: tx.chainID,
      version: tx.version,
      options: tx.options,
      signature: Buffer.from(sig).toString("hex"),
    };

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: asset,
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    return {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };
  }

  it("1. should successfully enqueue and settle a payment request", async () => {
    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const queue = new SettlementQueue({
      settler,
      relayerPool,
    });

    const request = await createSettleRequest();
    const response = await queue.enqueue(request);

    expect(response.success).toBe(true);
    expect(response.transaction).toBe("0xhash1");
    expect(response.payer).toBe(userAddress.toBech32());
    expect(broadcastCount).toBe(1);
  });

  it("2. should route requests to shard queues based on sender address", async () => {
    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const queue = new SettlementQueue({
      settler,
      relayerPool,
    });

    const senderShard = relayerPool.getShardForAddress(userAddress.toBech32());
    const request = await createSettleRequest();

    const response = await queue.enqueue(request);
    expect(response.success).toBe(true);

    const shardStats = queue.getShardStats();
    expect(shardStats[senderShard].processedCount).toBe(1);
  });

  it("3. should execute settlements on different shards concurrently without blocking", async () => {
    // Generate signers for shard 0 and shard 1
    const m0 = Mnemonic.generate();
    let signerShard0: UserSigner | undefined;
    let signerShard1: UserSigner | undefined;

    for (let i = 0; i < 50; i++) {
      const s = new UserSigner(m0.deriveKey(i));
      const shard = relayerPool.getShardForAddress(s.getAddress().bech32());
      if (shard === 0 && !signerShard0) signerShard0 = s;
      if (shard === 1 && !signerShard1) signerShard1 = s;
      if (signerShard0 && signerShard1) break;
    }

    expect(signerShard0).toBeDefined();
    expect(signerShard1).toBeDefined();

    let shard0Active = false;
    let shard1Active = false;
    let concurrentExecutionObserved = false;

    const mockSettler: ISettlerService = {
      settle: async (req: SettleRequest): Promise<SettleResponse> => {
        const rawPayload = req.paymentPayload.payload;
        const txPayload = "transaction" in rawPayload ? rawPayload.transaction : rawPayload;
        const shard = relayerPool.getShardForAddress(txPayload.sender);

        if (shard === 0) shard0Active = true;
        if (shard === 1) shard1Active = true;

        if (shard0Active && shard1Active) {
          concurrentExecutionObserved = true;
        }

        // Small delay to allow concurrency overlap
        await new Promise((resolve) => setTimeout(resolve, 30));

        if (shard === 0) shard0Active = false;
        if (shard === 1) shard1Active = false;

        return {
          success: true,
          transaction: `0xhash-shard-${shard}`,
          network: req.paymentRequirements.network,
          payer: txPayload.sender,
        };
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
    });

    const req0 = await createSettleRequest({ signer: signerShard0! });
    const req1 = await createSettleRequest({ signer: signerShard1! });

    const [res0, res1] = await Promise.all([queue.enqueue(req0), queue.enqueue(req1)]);

    expect(res0.success).toBe(true);
    expect(res1.success).toBe(true);
    expect(concurrentExecutionObserved).toBe(true);
  });

  it("4. should serialize settlements on the same shard to prevent relayer nonce collision", async () => {
    let concurrentSameShardCount = 0;
    let maxConcurrentSameShard = 0;

    const mockSettler: ISettlerService = {
      settle: async (req: SettleRequest): Promise<SettleResponse> => {
        concurrentSameShardCount++;
        if (concurrentSameShardCount > maxConcurrentSameShard) {
          maxConcurrentSameShard = concurrentSameShardCount;
        }

        await new Promise((resolve) => setTimeout(resolve, 20));

        concurrentSameShardCount--;
        return {
          success: true,
          transaction: "0xhash",
          network: req.paymentRequirements.network,
        };
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
    });

    // Enqueue 5 requests for the exact same sender (same shard)
    const reqs = await Promise.all([
      createSettleRequest({ nonce: 0n }),
      createSettleRequest({ nonce: 1n }),
      createSettleRequest({ nonce: 2n }),
      createSettleRequest({ nonce: 3n }),
      createSettleRequest({ nonce: 4n }),
    ]);

    const results = await Promise.all(reqs.map((r) => queue.enqueue(r)));

    expect(results.every((r) => r.success)).toBe(true);
    // Max concurrency on same shard must be 1
    expect(maxConcurrentSameShard).toBe(1);
  });

  it("5. should retry on transient errors with exponential backoff and succeed", async () => {
    let attempts = 0;
    const mockSettler: ISettlerService = {
      settle: async (req: SettleRequest): Promise<SettleResponse> => {
        attempts++;
        if (attempts < 3) {
          throw new Error("RPC gateway temporary 429 rate limit exceeded");
        }
        return {
          success: true,
          transaction: "0xhash-retry-success",
          network: req.paymentRequirements.network,
        };
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });

    const request = await createSettleRequest();
    const response = await queue.enqueue(request);

    expect(response.success).toBe(true);
    expect(response.transaction).toBe("0xhash-retry-success");
    expect(attempts).toBe(3);
  });

  it("6. should not retry on non-transient errors (e.g. PAYMENT_INVALID, PAYMENT_UNFUNDED)", async () => {
    let attempts = 0;
    const mockSettler: ISettlerService = {
      settle: async (req: SettleRequest): Promise<SettleResponse> => {
        attempts++;
        return {
          success: false,
          errorCode: PaymentErrorCode.PAYMENT_UNFUNDED,
          errorReason: "Insufficient funds in sender account",
          network: req.paymentRequirements.network,
        };
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    const request = await createSettleRequest();
    const response = await queue.enqueue(request);

    expect(response.success).toBe(false);
    expect(response.errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
    // Non-transient errors must NOT be retried
    expect(attempts).toBe(1);
  });

  it("7. should exhaust retries on persistent transient error and return failure", async () => {
    let attempts = 0;
    const mockSettler: ISettlerService = {
      settle: async (): Promise<SettleResponse> => {
        attempts++;
        throw new Error("Network timeout: connection refused");
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
      maxRetries: 2,
      baseDelayMs: 5,
    });

    const request = await createSettleRequest();
    const response = await queue.enqueue(request);

    expect(response.success).toBe(false);
    expect(response.errorReason).toContain("Network timeout");
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it("8. should handle high-burst throughput under parallel load of 100 requests", async () => {
    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const queue = new SettlementQueue({
      settler,
      relayerPool,
    });

    // Generate 100 requests
    const promises: Promise<SettleResponse>[] = [];
    for (let i = 0; i < 100; i++) {
      const req = await createSettleRequest({ nonce: BigInt(i) });
      promises.push(queue.enqueue(req));
    }

    const results = await Promise.all(promises);

    expect(results.length).toBe(100);
    expect(results.every((r) => r.success)).toBe(true);
    expect(broadcastCount).toBe(100);
    expect(queue.getPendingCount()).toBe(0);
  });

  it("9. should track queue lengths and drain properly", async () => {
    let finishCount = 0;
    const mockSettler: ISettlerService = {
      settle: async (req: SettleRequest): Promise<SettleResponse> => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        finishCount++;
        return {
          success: true,
          transaction: `0xhash-${finishCount}`,
          network: req.paymentRequirements.network,
        };
      },
      getSettlement: async () => null,
    };

    const queue = new SettlementQueue({
      settler: mockSettler,
      relayerPool,
    });

    const reqs = await Promise.all([
      createSettleRequest({ nonce: 0n }),
      createSettleRequest({ nonce: 1n }),
      createSettleRequest({ nonce: 2n }),
      createSettleRequest({ nonce: 3n }),
    ]);

    // Enqueue without awaiting individually
    reqs.forEach((r) => queue.enqueue(r));

    expect(queue.getPendingCount()).toBe(4);

    await queue.drain();

    expect(queue.getPendingCount()).toBe(0);
    expect(finishCount).toBe(4);
  });
});
