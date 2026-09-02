import { describe, it, expect, beforeEach, vi } from "vitest";
import { Address } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { RelayerTreasuryService } from "../../src/services/treasury_service.js";
import { INetworkProvider } from "../../src/domain/network.js";

describe("RelayerTreasuryService (Auto-Replenishment Daemon)", () => {
  let treasuryMnemonic: Mnemonic;
  let treasurySigner: UserSigner;
  let treasuryAddress: string;

  let relayerMnemonic: Mnemonic;
  let relayerPool: RelayerPoolManager;

  let mockNetworkProvider: INetworkProvider;
  let sentTransactions: any[];
  let relayerBalances: Record<string, string>;

  beforeEach(() => {
    treasuryMnemonic = Mnemonic.generate();
    treasurySigner = new UserSigner(treasuryMnemonic.deriveKey(0));
    treasuryAddress = treasurySigner.getAddress().bech32();

    relayerMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString(), {
      shardsToCover: [0, 1, 2],
    });

    sentTransactions = [];
    relayerBalances = {};

    // Initialize relayer balances
    for (const [shard, addrs] of Object.entries(relayerPool.getAllRelayerAddressesMulti())) {
      for (const addr of addrs) {
        relayerBalances[addr] = "1000000000000000000"; // 1 EGLD default
      }
    }

    mockNetworkProvider = {
      getAccount: async (address: any) => {
        const addrStr =
          typeof address === "string"
            ? address
            : typeof address.bech32 === "function"
              ? address.bech32()
              : address.toBech32();
        if (addrStr === treasuryAddress) {
          return {
            balance: "100000000000000000000", // 100 EGLD
            nonce: sentTransactions.length,
          };
        }
        return {
          balance: relayerBalances[addrStr] ?? "0",
          nonce: 0,
        };
      },
      sendTransaction: async (tx: any) => {
        sentTransactions.push(tx);
        return `0xhash${sentTransactions.length}`;
      },
      simulateTransaction: async () => ({ status: "success", returnCode: "ok" }),
      getTransaction: async () => ({}),
    };
  });

  it("should not replenish relayers when all balances exceed the threshold", async () => {
    const service = new RelayerTreasuryService({
      networkProvider: mockNetworkProvider,
      relayerPool,
      treasurySigner,
      minBalanceThreshold: 500_000_000_000_000_000n, // 0.5 EGLD
      refillAmount: 2_000_000_000_000_000_000n, // 2 EGLD
      chainID: "D",
    });

    const result = await service.checkAndReplenishOnce();
    expect(result.checked).toBeGreaterThanOrEqual(3);
    expect(result.replenished).toBe(0);
    expect(result.txHashes.length).toBe(0);
    expect(sentTransactions.length).toBe(0);
  });

  it("should automatically replenish relayer wallets when balance falls below threshold", async () => {
    const shard0Addr = relayerPool.getRelayerAddressForShard(0);
    // Deplete shard 0 relayer balance to 0.1 EGLD
    relayerBalances[shard0Addr] = "100000000000000000";

    const service = new RelayerTreasuryService({
      networkProvider: mockNetworkProvider,
      relayerPool,
      treasurySigner,
      minBalanceThreshold: 500_000_000_000_000_000n, // 0.5 EGLD
      refillAmount: 2_000_000_000_000_000_000n, // 2 EGLD
      chainID: "D",
    });

    const result = await service.checkAndReplenishOnce();
    expect(result.replenished).toBe(1);
    expect(result.txHashes.length).toBe(1);
    expect(sentTransactions.length).toBe(1);

    const tx = sentTransactions[0];
    expect(tx.receiver.toBech32()).toBe(shard0Addr);
    expect(tx.sender.toBech32()).toBe(treasuryAddress);
    expect(tx.value.toString()).toBe("2000000000000000000");
  });

  it("should handle multiple depleted relayers across different shards", async () => {
    const shard0Addr = relayerPool.getRelayerAddressForShard(0);
    const shard1Addr = relayerPool.getRelayerAddressForShard(1);

    relayerBalances[shard0Addr] = "50000000000000000"; // 0.05 EGLD
    relayerBalances[shard1Addr] = "200000000000000000"; // 0.2 EGLD

    const service = new RelayerTreasuryService({
      networkProvider: mockNetworkProvider,
      relayerPool,
      treasurySigner,
      minBalanceThreshold: 500_000_000_000_000_000n,
      refillAmount: 1_500_000_000_000_000_000n,
      chainID: "D",
    });

    const result = await service.checkAndReplenishOnce();
    expect(result.replenished).toBe(2);
    expect(result.txHashes.length).toBe(2);
    expect(sentTransactions.length).toBe(2);
  });

  it("should start and stop periodic polling daemon cleanly", () => {
    const service = new RelayerTreasuryService({
      networkProvider: mockNetworkProvider,
      relayerPool,
      treasurySigner,
      checkIntervalMs: 1000,
      chainID: "D",
    });

    service.start();
    expect(service.isRunning()).toBe(true);

    service.stop();
    expect(service.isRunning()).toBe(false);
  });
});
