import { describe, it, expect, beforeEach } from "vitest";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { SettlementQueue } from "../../src/services/settlement_queue.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";
import { buildEsdtTransferData } from "../../src/utils/data_parser.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";

describe("High-Throughput Burst Load Testing Harness", () => {
  let relayerPool: RelayerPoolManager;
  let settlementQueue: SettlementQueue;
  let storage: MemorySettlementStorage;
  let broadcastedTxs: Transaction[];
  let tc: TransactionComputer;

  let merchantAddress: Address;
  let userSigner: UserSigner;
  let userAddress: Address;

  beforeEach(async () => {
    tc = new TransactionComputer();
    broadcastedTxs = [];
    storage = new MemorySettlementStorage();

    const merchantMnemonic = Mnemonic.generate();
    const merchantSigner = new UserSigner(merchantMnemonic.deriveKey(0));
    merchantAddress = Address.newFromBech32(merchantSigner.getAddress().bech32());

    const userMnemonic = Mnemonic.generate();
    userSigner = new UserSigner(userMnemonic.deriveKey(0));
    userAddress = Address.newFromBech32(userSigner.getAddress().bech32());

    // 4 relayers per shard (16 total relayers)
    const masterMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(masterMnemonic.toString(), {
      relayersPerShard: 4,
    });

    const mockNetworkProvider: INetworkProvider = {
      sendTransaction: async (tx) => {
        broadcastedTxs.push(tx);
        return `tx-hash-${broadcastedTxs.length}`;
      },
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      getTransaction: async () => ({ status: "success" }),
      getAccount: async (addr) => {
        const addrStr = addr.toBech32();
        const nonce = broadcastedTxs.filter((t) => t.sender.toBech32() === addrStr).length;
        return { nonce, balance: "1000000000000000000" };
      },
    };

    settlementQueue = new SettlementQueue({
      storage,
      networkProvider: mockNetworkProvider,
      relayerPool,
      simulationEnabled: false,
      concurrencyPerShard: 4,
      maxQueueSize: 5000,
    });
  });

  it("should process 60 concurrent settlement requests across shards with zero nonce collisions", async () => {
    const totalRequests = 60;
    const promises: Promise<any>[] = [];

    const startTime = Date.now();

    for (let i = 0; i < totalRequests; i++) {
      const amount = (1000 + i).toString();
      const asset = "USDC-c76f1f";
      const relayerAddr = relayerPool.getNextRelayerAddressForUser(userAddress.toBech32());

      const tx = new Transaction({
        nonce: BigInt(i + 1),
        value: 0n,
        sender: userAddress,
        receiver: merchantAddress,
        gasPrice: 1000000000n,
        gasLimit: 500000n,
        data: Buffer.from(buildEsdtTransferData(asset, amount)),
        chainID: "1",
        version: 2,
        options: 0,
        relayer: Address.newFromBech32(relayerAddr),
      });

      const bytesToSign = tc.computeBytesForSigning(tx);
      const userSig = await userSigner.sign(bytesToSign);

      const payload = {
        x402Version: 2 as const,
        resource: { url: "https://api.blockrun.ai/v1/chat/completions" },
        accepted: {
          scheme: "exact" as const,
          network: "multiversx:1",
          amount,
          asset,
          payTo: merchantAddress.toBech32(),
          maxTimeoutSeconds: 300,
        },
        payload: {
          nonce: i + 1,
          value: "0",
          receiver: merchantAddress.toBech32(),
          sender: userAddress.toBech32(),
          gasPrice: 1000000000,
          gasLimit: 500000,
          data: buildEsdtTransferData(asset, amount),
          chainID: "1",
          version: 2,
          options: 0,
          signature: userSig.toString("hex"),
          relayer: relayerAddr,
        },
      };

      promises.push(
        settlementQueue.enqueue({
          paymentPayload: payload,
          paymentRequirements: payload.accepted,
        })
      );
    }

    const results = await Promise.all(promises);
    const durationMs = Date.now() - startTime;

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error("Failed settlement items:", failed.slice(0, 3));
    }

    expect(results).toHaveLength(totalRequests);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.transaction).toBeDefined();
    }

    // Verify all broadcasted transactions
    expect(broadcastedTxs).toHaveLength(totalRequests);

    // Verify all unique nonces arrived without loss or collisions
    const nonces = broadcastedTxs.map((t) => Number(t.nonce)).sort((a, b) => a - b);
    expect(nonces).toHaveLength(totalRequests);
    expect(new Set(nonces).size).toBe(totalRequests);
    expect(nonces[0]).toBe(1);
    expect(nonces[nonces.length - 1]).toBe(totalRequests);

    console.log(
      `Burst load completed: ${totalRequests} txs in ${durationMs}ms (${((totalRequests / durationMs) * 1000).toFixed(1)} tx/sec)`
    );
  });
});
