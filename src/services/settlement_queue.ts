import { Address, AddressComputer } from "@multiversx/sdk-core";
import {
  PaymentErrorCode,
  SettleRequest,
  SettleResponse,
  MvxTransactionPayload,
} from "../domain/types.js";
import { SettlerService, ISettlerService } from "./settler.js";
import { RelayerPoolManager, METACHAIN_SHARD_ID } from "./relayer_pool.js";
import { ISettlementStorage } from "../storage/types.js";
import { INetworkProvider } from "../domain/network.js";

/**
 * Statistics tracked per shard queue.
 */
export interface ShardQueueStats {
  shard: number;
  pendingCount: number;
  processedCount: number;
  failedCount: number;
}

/**
 * Configuration options for SettlementQueue.
 */
export interface SettlementQueueConfig {
  settler?: ISettlerService;
  storage?: ISettlementStorage;
  networkProvider?: INetworkProvider;
  simulationEnabled?: boolean;
  concurrencyPerShard?: number;
  relayerPool?: RelayerPoolManager;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  maxQueueSize?: number;
  isTransientError?: (error: unknown, response?: SettleResponse) => boolean;
}

/**
 * Interface defining SettlementQueue operations.
 */
export interface ISettlementQueue {
  enqueue(request: SettleRequest): Promise<SettleResponse>;
  getPendingCount(shard?: number): number;
  getShardStats(): Record<number, ShardQueueStats>;
  drain(): Promise<void>;
  clear(): void;
}

interface QueuedItem {
  request: SettleRequest;
  resolve: (response: SettleResponse) => void;
  reject: (error: unknown) => void;
}

/**
 * Single shard asynchronous worker queue.
 * Ensures strict concurrency serialization (mutex) per relayer wallet to prevent nonce collision.
 */
class ShardWorker {
  public readonly shard: number;
  public readonly relayerAddress?: string;
  private readonly settler: ISettlerService;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly isTransientFn: (error: unknown, response?: SettleResponse) => boolean;

  private queue: QueuedItem[] = [];
  private isProcessing = false;
  private drainResolvers: Array<() => void> = [];

  public pendingCount = 0;
  public processedCount = 0;
  public failedCount = 0;

  constructor(
    shard: number,
    settler: ISettlerService,
    config: {
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
      backoffMultiplier: number;
      relayerAddress?: string;
      isTransientFn: (error: unknown, response?: SettleResponse) => boolean;
    }
  ) {
    this.shard = shard;
    this.settler = settler;
    this.relayerAddress = config.relayerAddress;
    this.maxRetries = config.maxRetries;
    this.baseDelayMs = config.baseDelayMs;
    this.maxDelayMs = config.maxDelayMs;
    this.backoffMultiplier = config.backoffMultiplier;
    this.isTransientFn = config.isTransientFn;
  }

  public enqueue(request: SettleRequest): Promise<SettleResponse> {
    this.pendingCount++;
    return new Promise<SettleResponse>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      if (this.queue.length === 0 && this.pendingCount === 0 && this.drainResolvers.length > 0) {
        const resolvers = [...this.drainResolvers];
        this.drainResolvers = [];
        resolvers.forEach((r) => r());
      }
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();
    if (!item) {
      this.isProcessing = false;
      return;
    }

    const { request, resolve } = item;

    try {
      const response = await this.executeWithRetry(request);
      if (response.success) {
        this.processedCount++;
      } else {
        this.failedCount++;
      }
      resolve(response);
    } catch (err: unknown) {
      this.failedCount++;
      const message = err instanceof Error ? err.message : String(err);
      const rawPayload = request.paymentPayload.payload;
      const txPayload: MvxTransactionPayload =
        "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

      resolve({
        success: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        errorReason: `Internal queue execution error: ${message}`,
        network: request.paymentRequirements.network,
        payer: txPayload.sender,
      });
    } finally {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.isProcessing = false;
      this.processNext();
    }
  }

  private async executeWithRetry(request: SettleRequest): Promise<SettleResponse> {
    let attempt = 0;
    let delay = this.baseDelayMs;

    while (true) {
      attempt++;
      try {
        const response = await this.settler.settle(request);

        if (response.success) {
          return response;
        }

        // Check if response error is classified as transient
        const isTransient = this.isTransientFn(null, response);
        if (!isTransient || attempt > this.maxRetries) {
          return response;
        }

        // Transient failure, wait and retry
        await this.sleep(delay);
        delay = Math.min(this.maxDelayMs, delay * this.backoffMultiplier);
      } catch (err: unknown) {
        const isTransient = this.isTransientFn(err);
        if (!isTransient || attempt > this.maxRetries) {
          throw err;
        }

        await this.sleep(delay);
        delay = Math.min(this.maxDelayMs, delay * this.backoffMultiplier);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public async drain(): Promise<void> {
    if (this.queue.length === 0 && this.pendingCount === 0 && !this.isProcessing) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  public clear(): void {
    this.queue = [];
    this.pendingCount = 0;
  }
}

/**
 * High-Throughput Shard-Partitioned Settlement Queue.
 * Routes transactions to dedicated workers across shards (Shard 0, 1, 2, Metachain)
 * with support for multiple parallel relayer workers per shard and backpressure safeguards.
 */
export class SettlementQueue implements ISettlementQueue {
  private readonly settler: ISettlerService;
  private readonly relayerPool?: RelayerPoolManager;
  private readonly addressComputer: AddressComputer;
  private readonly shardWorkers: Map<number, ShardWorker[]> = new Map();

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxQueueSize: number;
  private readonly isTransientFn: (error: unknown, response?: SettleResponse) => boolean;

  constructor(config: SettlementQueueConfig) {
    if (config.settler) {
      this.settler = config.settler;
    } else if (config.storage && config.networkProvider) {
      this.settler = new SettlerService({
        storage: config.storage,
        networkProvider: config.networkProvider,
        relayerPool: config.relayerPool,
        simulateBeforeBroadcast: config.simulationEnabled ?? false,
      });
    } else {
      throw new Error(
        "SettlementQueue requires either 'settler' or both 'storage' and 'networkProvider'"
      );
    }
    this.relayerPool = config.relayerPool;
    this.addressComputer = new AddressComputer();

    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 50;
    this.maxDelayMs = config.maxDelayMs ?? 2000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.maxQueueSize = config.maxQueueSize ?? 2000;
    this.isTransientFn = config.isTransientError ?? SettlementQueue.defaultIsTransientError;

    // Initialize standard shard workers (0, 1, 2, Metachain)
    const initialShards = [0, 1, 2, METACHAIN_SHARD_ID];
    for (const shard of initialShards) {
      this.getOrCreateWorkersForShard(shard);
    }
  }

  /**
   * Default classifier for transient network and rate limit errors.
   */
  public static defaultIsTransientError(error: unknown, response?: SettleResponse): boolean {
    if (response) {
      // Non-transient standard error codes
      if (
        response.errorCode === PaymentErrorCode.PAYMENT_INVALID ||
        response.errorCode === PaymentErrorCode.PAYMENT_UNFUNDED ||
        response.errorCode === PaymentErrorCode.PAYMENT_EXPIRED ||
        response.errorCode === PaymentErrorCode.PAYMENT_REPLAY
      ) {
        return false;
      }

      if (response.errorReason) {
        const rLower = response.errorReason.toLowerCase();
        return (
          rLower.includes("timeout") ||
          rLower.includes("rate limit") ||
          rLower.includes("429") ||
          rLower.includes("503") ||
          rLower.includes("502") ||
          rLower.includes("504") ||
          rLower.includes("connection reset") ||
          rLower.includes("network") ||
          rLower.includes("temporary") ||
          rLower.includes("nonce") ||
          rLower.includes("busy")
        );
      }
    }

    if (error) {
      const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
      return (
        msg.includes("timeout") ||
        msg.includes("connect") ||
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("504") ||
        msg.includes("rate limit") ||
        msg.includes("reset") ||
        msg.includes("temporary") ||
        msg.includes("busy") ||
        msg.includes("nonce") ||
        msg.includes("econnrefused") ||
        msg.includes("econnreset") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout")
      );
    }

    return false;
  }

  private getOrCreateWorkersForShard(shard: number): ShardWorker[] {
    let workers = this.shardWorkers.get(shard);
    if (!workers || workers.length === 0) {
      workers = [];

      if (this.relayerPool && this.relayerPool.hasShard(shard)) {
        const relayers = this.relayerPool.getAllRelayersForShard(shard);
        for (const relayer of relayers) {
          const relayerAddress = relayer.getAddress().bech32();
          workers.push(
            new ShardWorker(shard, this.settler, {
              maxRetries: this.maxRetries,
              baseDelayMs: this.baseDelayMs,
              maxDelayMs: this.maxDelayMs,
              backoffMultiplier: this.backoffMultiplier,
              relayerAddress,
              isTransientFn: this.isTransientFn,
            })
          );
        }
      }

      // If no pool or no relayers for shard, create default fallback worker
      if (workers.length === 0) {
        workers.push(
          new ShardWorker(shard, this.settler, {
            maxRetries: this.maxRetries,
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxDelayMs,
            backoffMultiplier: this.backoffMultiplier,
            isTransientFn: this.isTransientFn,
          })
        );
      }

      this.shardWorkers.set(shard, workers);
    }
    return workers;
  }

  /**
   * Determines the shard for a settlement request from its sender address.
   */
  public getShardForRequest(request: SettleRequest): number {
    const rawPayload = request.paymentPayload.payload;
    const txPayload: MvxTransactionPayload =
      "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

    try {
      if (this.relayerPool) {
        return this.relayerPool.getShardForAddress(txPayload.sender);
      }
      const addr = Address.newFromBech32(txPayload.sender);
      return this.addressComputer.getShardOfAddress(addr);
    } catch {
      return 0; // Default to shard 0 if unparseable
    }
  }

  /**
   * Enqueues a settlement request into the appropriate shard relayer worker queue.
   */
  async enqueue(request: SettleRequest): Promise<SettleResponse> {
    const totalPending = this.getPendingCount();
    if (totalPending >= this.maxQueueSize) {
      const rawPayload = request.paymentPayload.payload;
      const txPayload: MvxTransactionPayload =
        "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

      return {
        success: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        errorReason: `Settlement queue saturated: current pending jobs (${totalPending}) exceeded max limit (${this.maxQueueSize})`,
        network: request.paymentRequirements.network,
        payer: txPayload.sender,
      };
    }

    const shard = this.getShardForRequest(request);
    const workers = this.getOrCreateWorkersForShard(shard);

    const rawPayload = request.paymentPayload.payload;
    const txPayload: MvxTransactionPayload =
      "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

    // Check if the transaction already targeted a specific relayer address
    let selectedWorker: ShardWorker | undefined;
    if (txPayload.relayer) {
      selectedWorker = workers.find((w) => w.relayerAddress === txPayload.relayer);
    }

    // Otherwise select the least-loaded worker in this shard
    if (!selectedWorker) {
      selectedWorker = workers.reduce((prev, curr) =>
        curr.pendingCount < prev.pendingCount ? curr : prev
      );
    }

    return selectedWorker.enqueue(request);
  }

  /**
   * Returns the count of pending/active settlement requests for a specific shard or across all shards.
   */
  getPendingCount(shard?: number): number {
    if (shard !== undefined) {
      const workers = this.shardWorkers.get(shard) || [];
      return workers.reduce((sum, w) => sum + w.pendingCount, 0);
    }

    let total = 0;
    for (const workers of this.shardWorkers.values()) {
      for (const worker of workers) {
        total += worker.pendingCount;
      }
    }
    return total;
  }

  /**
   * Returns statistics for each shard queue.
   */
  getShardStats(): Record<number, ShardQueueStats> {
    const stats: Record<number, ShardQueueStats> = {};
    for (const [shard, workers] of this.shardWorkers.entries()) {
      stats[shard] = {
        shard,
        pendingCount: workers.reduce((sum, w) => sum + w.pendingCount, 0),
        processedCount: workers.reduce((sum, w) => sum + w.processedCount, 0),
        failedCount: workers.reduce((sum, w) => sum + w.failedCount, 0),
      };
    }
    return stats;
  }

  /**
   * Waits until all currently enqueued settlement requests across all shard queues have completed.
   */
  async drain(): Promise<void> {
    const drainPromises: Promise<void>[] = [];
    for (const workers of this.shardWorkers.values()) {
      for (const worker of workers) {
        drainPromises.push(worker.drain());
      }
    }
    await Promise.all(drainPromises);
  }

  /**
   * Clears all pending requests from all shard queues.
   */
  clear(): void {
    for (const workers of this.shardWorkers.values()) {
      for (const worker of workers) {
        worker.clear();
      }
    }
  }
}
