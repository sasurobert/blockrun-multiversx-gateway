import { Address, AddressComputer } from "@multiversx/sdk-core";
import {
  PaymentErrorCode,
  SettleRequest,
  SettleResponse,
  MvxTransactionPayload,
} from "../domain/types.js";
import { ISettlerService } from "./settler.js";
import { RelayerPoolManager, METACHAIN_SHARD_ID } from "./relayer_pool.js";

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
  settler: ISettlerService;
  relayerPool?: RelayerPoolManager;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
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
 * Ensures strict concurrency serialization (mutex) per shard relayer to prevent nonce collision.
 */
class ShardWorker {
  public readonly shard: number;
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
      isTransientFn: (error: unknown, response?: SettleResponse) => boolean;
    }
  ) {
    this.shard = shard;
    this.settler = settler;
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

    try {
      const response = await this.executeWithRetry(item.request);
      if (response.success) {
        this.processedCount++;
      } else {
        this.failedCount++;
      }
      item.resolve(response);
    } catch (err: unknown) {
      this.failedCount++;
      const message = err instanceof Error ? err.message : String(err);
      item.resolve({
        success: false,
        errorReason: message,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        network: item.request.paymentRequirements.network,
      });
    } finally {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.isProcessing = false;
      this.processNext();
    }
  }

  private async executeWithRetry(request: SettleRequest): Promise<SettleResponse> {
    let attempt = 0;
    let lastError: unknown;
    let lastResponse: SettleResponse | undefined;

    while (attempt <= this.maxRetries) {
      try {
        const response = await this.settler.settle(request);
        if (response.success) {
          return response;
        }

        // Response indicated failure
        lastResponse = response;
        if (!this.isTransientFn(undefined, response)) {
          // Deterministic error (e.g. invalid signature, expired, unfunded) -> do not retry
          return response;
        }

        // Transient error in response -> retry
        lastError = new Error(response.errorReason || "Transient settlement failure");
      } catch (err: unknown) {
        lastError = err;
        if (!this.isTransientFn(err, undefined)) {
          throw err;
        }
      }

      attempt++;
      if (attempt <= this.maxRetries) {
        const delay = Math.min(
          this.maxDelayMs,
          this.baseDelayMs * Math.pow(this.backoffMultiplier, attempt - 1)
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return {
      success: false,
      errorReason: message,
      errorCode: PaymentErrorCode.PAYMENT_INVALID,
      network: request.paymentRequirements.network,
    };
  }

  public drain(): Promise<void> {
    if (this.pendingCount === 0 && this.queue.length === 0 && !this.isProcessing) {
      return Promise.resolve();
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
 * Routes transactions to dedicated per-shard workers (Shard 0, 1, 2, Metachain)
 * with strict relayer nonce serialization and exponential retry on transient errors.
 */
export class SettlementQueue implements ISettlementQueue {
  private readonly settler: ISettlerService;
  private readonly relayerPool?: RelayerPoolManager;
  private readonly addressComputer: AddressComputer;
  private readonly shardWorkers: Map<number, ShardWorker> = new Map();

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly isTransientFn: (error: unknown, response?: SettleResponse) => boolean;

  constructor(config: SettlementQueueConfig) {
    this.settler = config.settler;
    this.relayerPool = config.relayerPool;
    this.addressComputer = new AddressComputer();

    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 50;
    this.maxDelayMs = config.maxDelayMs ?? 2000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.isTransientFn = config.isTransientError ?? SettlementQueue.defaultIsTransientError;

    // Initialize standard shard workers (0, 1, 2, Metachain)
    const initialShards = [0, 1, 2, METACHAIN_SHARD_ID];
    for (const shard of initialShards) {
      this.getOrCreateWorker(shard);
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

  private getOrCreateWorker(shard: number): ShardWorker {
    let worker = this.shardWorkers.get(shard);
    if (!worker) {
      worker = new ShardWorker(shard, this.settler, {
        maxRetries: this.maxRetries,
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        backoffMultiplier: this.backoffMultiplier,
        isTransientFn: this.isTransientFn,
      });
      this.shardWorkers.set(shard, worker);
    }
    return worker;
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
   * Enqueues a settlement request into the appropriate shard worker queue.
   */
  async enqueue(request: SettleRequest): Promise<SettleResponse> {
    const shard = this.getShardForRequest(request);
    const worker = this.getOrCreateWorker(shard);
    return worker.enqueue(request);
  }

  /**
   * Returns the count of pending/active settlement requests for a specific shard or across all shards.
   */
  getPendingCount(shard?: number): number {
    if (shard !== undefined) {
      return this.shardWorkers.get(shard)?.pendingCount ?? 0;
    }

    let total = 0;
    for (const worker of this.shardWorkers.values()) {
      total += worker.pendingCount;
    }
    return total;
  }

  /**
   * Returns statistics for each shard queue.
   */
  getShardStats(): Record<number, ShardQueueStats> {
    const stats: Record<number, ShardQueueStats> = {};
    for (const [shard, worker] of this.shardWorkers.entries()) {
      stats[shard] = {
        shard,
        pendingCount: worker.pendingCount,
        processedCount: worker.processedCount,
        failedCount: worker.failedCount,
      };
    }
    return stats;
  }

  /**
   * Waits until all currently enqueued settlement requests across all shard queues have completed.
   */
  async drain(): Promise<void> {
    const drainPromises: Promise<void>[] = [];
    for (const worker of this.shardWorkers.values()) {
      drainPromises.push(worker.drain());
    }
    await Promise.all(drainPromises);
  }

  /**
   * Clears all pending requests from all shard queues.
   */
  clear(): void {
    for (const worker of this.shardWorkers.values()) {
      worker.clear();
    }
  }
}
