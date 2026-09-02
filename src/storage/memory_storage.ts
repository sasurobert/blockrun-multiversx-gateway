import {
  ISettlementStorage,
  SettlementFilter,
  SettlementRecord,
  SettlementStatus,
  StatusUpdateDetails,
} from "./types.js";

/**
 * In-memory implementation of ISettlementStorage.
 * Designed for high-speed unit tests and ephemeral environments.
 */
export class MemorySettlementStorage implements ISettlementStorage {
  private readonly records: Map<string, SettlementRecord> = new Map();
  private readonly sigHashIndex: Map<string, string> = new Map();

  async save(record: SettlementRecord): Promise<void> {
    const clone: SettlementRecord = { ...record };
    this.records.set(clone.id, clone);
    this.sigHashIndex.set(clone.signatureHash, clone.id);
  }

  async getById(id: string): Promise<SettlementRecord | null> {
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    return { ...record };
  }

  async getBySignatureHash(signatureHash: string): Promise<SettlementRecord | null> {
    const id = this.sigHashIndex.get(signatureHash);
    if (!id) {
      return null;
    }
    return this.getById(id);
  }

  async updateStatus(
    id: string,
    status: SettlementStatus,
    details?: StatusUpdateDetails
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }

    const updated: SettlementRecord = {
      ...record,
      status,
      updatedAt: Date.now(),
      txHash: details?.txHash !== undefined ? details.txHash : record.txHash,
      errorReason: details?.errorReason !== undefined ? details.errorReason : record.errorReason,
      errorCode: details?.errorCode !== undefined ? details.errorCode : record.errorCode,
    };

    this.records.set(id, updated);
  }

  async list(filter?: SettlementFilter): Promise<SettlementRecord[]> {
    let results = Array.from(this.records.values());

    if (filter?.payer) {
      results = results.filter((r) => r.payer === filter.payer);
    }
    if (filter?.status) {
      results = results.filter((r) => r.status === filter.status);
    }

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;

    return results.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  async close(): Promise<void> {
    this.records.clear();
    this.sigHashIndex.clear();
  }
}
