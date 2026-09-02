import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { UserSigner } from "@multiversx/sdk-wallet";
import { INetworkProvider } from "../domain/network.js";
import { RelayerPoolManager } from "./relayer_pool.js";

export interface RelayerTreasuryConfig {
  networkProvider: INetworkProvider;
  relayerPool: RelayerPoolManager;
  treasurySigner: UserSigner;
  minBalanceThreshold?: bigint;
  refillAmount?: bigint;
  chainID?: string;
  checkIntervalMs?: number;
}

export interface ReplenishResult {
  checked: number;
  replenished: number;
  txHashes: string[];
}

/**
 * Automated Relayer Treasury Management Daemon.
 * Monitors relayer wallet EGLD balances across all shards and automatically dispatches
 * top-up transactions from a master treasury wallet when balances fall below threshold.
 */
export class RelayerTreasuryService {
  private readonly networkProvider: INetworkProvider;
  private readonly relayerPool: RelayerPoolManager;
  private readonly treasurySigner: UserSigner;
  private readonly minBalanceThreshold: bigint;
  private readonly refillAmount: bigint;
  private readonly chainID: string;
  private readonly checkIntervalMs: number;
  private readonly tc: TransactionComputer;

  private timer: ReturnType<typeof setInterval> | null = null;
  private localNonce = 0;
  private isChecking = false;

  constructor(config: RelayerTreasuryConfig) {
    this.networkProvider = config.networkProvider;
    this.relayerPool = config.relayerPool;
    this.treasurySigner = config.treasurySigner;
    this.minBalanceThreshold = config.minBalanceThreshold ?? 500_000_000_000_000_000n; // 0.5 EGLD
    this.refillAmount = config.refillAmount ?? 2_000_000_000_000_000_000n; // 2 EGLD
    this.chainID = config.chainID ?? "1";
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
    this.tc = new TransactionComputer();
  }

  /**
   * Starts the background auto-replenishment monitoring timer.
   */
  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.checkAndReplenishOnce().catch(() => {});
    }, this.checkIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stops the background monitoring timer.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Checks if the background monitoring timer is currently running.
   */
  public isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Executes an immediate check of all configured relayer balances and dispatches refills if needed.
   */
  public async checkAndReplenishOnce(): Promise<ReplenishResult> {
    if (this.isChecking) {
      return { checked: 0, replenished: 0, txHashes: [] };
    }

    this.isChecking = true;
    const txHashes: string[] = [];
    let checked = 0;
    let replenished = 0;

    try {
      const treasuryAddress = Address.newFromBech32(
        this.treasurySigner.getAddress().bech32()
      );
      const treasuryAccount = (await this.networkProvider.getAccount(treasuryAddress)) as any;
      if (treasuryAccount && typeof treasuryAccount.nonce === "number") {
        this.localNonce = Math.max(this.localNonce, treasuryAccount.nonce);
      }

      // Collect all relayer addresses across all shards
      const allAddressesMap = this.relayerPool.getAllRelayerAddressesMulti();
      const allRelayerAddresses: string[] = [];
      for (const addrs of Object.values(allAddressesMap)) {
        for (const addr of addrs) {
          if (!allRelayerAddresses.includes(addr)) {
            allRelayerAddresses.push(addr);
          }
        }
      }

      for (const relayerAddr of allRelayerAddresses) {
        checked++;
        try {
          const relayerAddressObj = Address.newFromBech32(relayerAddr);
          const account = (await this.networkProvider.getAccount(relayerAddressObj)) as any;
          const balanceStr = account?.balance?.toString() ?? "0";
          const balance = BigInt(balanceStr);

          if (balance < this.minBalanceThreshold) {
            const txHash = await this.sendRefillTransaction(relayerAddr);
            txHashes.push(txHash);
            replenished++;
          }
        } catch {
          // Log and continue to next relayer
        }
      }
    } finally {
      this.isChecking = false;
    }

    return { checked, replenished, txHashes };
  }

  private async sendRefillTransaction(receiverAddress: string): Promise<string> {
    const sender = Address.newFromBech32(this.treasurySigner.getAddress().bech32());
    const receiver = Address.newFromBech32(receiverAddress);

    const tx = new Transaction({
      nonce: BigInt(this.localNonce),
      value: this.refillAmount,
      sender,
      receiver,
      gasPrice: 1_000_000_000n,
      gasLimit: 50_000n,
      data: Buffer.from(""),
      chainID: this.chainID,
      version: 1,
      options: 0,
    });

    const bytes = this.tc.computeBytesForSigning(tx);
    const signature = await this.treasurySigner.sign(bytes);
    tx.signature = signature;

    this.localNonce++;
    return this.networkProvider.sendTransaction(tx);
  }
}
