import Database, { Database as DatabaseType } from "better-sqlite3";
import {
  ISettlementStorage,
  SettlementFilter,
  SettlementRecord,
  SettlementStatus,
  StatusUpdateDetails,
} from "./types.js";

interface SettlementRow {
  id: string;
  signature_hash: string;
  payer: string;
  receiver: string;
  asset: string;
  amount: string;
  status: string;
  tx_hash: string | null;
  error_reason: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  valid_before: number | null;
}

/**
 * SQLite-backed implementation of ISettlementStorage.
 * Designed for persistent and embedded production storage.
 */
export class SqliteSettlementStorage implements ISettlementStorage {
  private readonly db: DatabaseType;

  constructor(dbPathOrDb: string | DatabaseType = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new Database(dbPathOrDb);
    } else {
      this.db = dbPathOrDb;
    }

    // Enable WAL mode for high concurrency if not in memory
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        id TEXT PRIMARY KEY,
        signature_hash TEXT NOT NULL UNIQUE,
        payer TEXT NOT NULL,
        receiver TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error_reason TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        valid_before INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_settlements_payer ON settlements(payer);
      CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
      CREATE INDEX IF NOT EXISTS idx_settlements_created_at ON settlements(created_at);
    `);
  }

  private mapRowToRecord(row: SettlementRow): SettlementRecord {
    return {
      id: row.id,
      signatureHash: row.signature_hash,
      payer: row.payer,
      receiver: row.receiver,
      asset: row.asset,
      amount: row.amount,
      status: row.status as SettlementStatus,
      txHash: row.tx_hash ?? undefined,
      errorReason: row.error_reason ?? undefined,
      errorCode: row.error_code ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      validBefore: row.valid_before !== null ? row.valid_before : undefined,
    };
  }

  async save(record: SettlementRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO settlements (
        id, signature_hash, payer, receiver, asset, amount,
        status, tx_hash, error_reason, error_code, created_at, updated_at, valid_before
      ) VALUES (
        @id, @signature_hash, @payer, @receiver, @asset, @amount,
        @status, @tx_hash, @error_reason, @error_code, @created_at, @updated_at, @valid_before
      )
      ON CONFLICT(id) DO UPDATE SET
        signature_hash = excluded.signature_hash,
        payer = excluded.payer,
        receiver = excluded.receiver,
        asset = excluded.asset,
        amount = excluded.amount,
        status = excluded.status,
        tx_hash = excluded.tx_hash,
        error_reason = excluded.error_reason,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at,
        valid_before = excluded.valid_before
    `);

    stmt.run({
      id: record.id,
      signature_hash: record.signatureHash,
      payer: record.payer,
      receiver: record.receiver,
      asset: record.asset,
      amount: record.amount,
      status: record.status,
      tx_hash: record.txHash ?? null,
      error_reason: record.errorReason ?? null,
      error_code: record.errorCode ?? null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      valid_before: record.validBefore ?? null,
    });
  }

  async getById(id: string): Promise<SettlementRecord | null> {
    const stmt = this.db.prepare<[string], SettlementRow>(
      "SELECT * FROM settlements WHERE id = ?"
    );
    const row = stmt.get(id);
    if (!row) {
      return null;
    }
    return this.mapRowToRecord(row);
  }

  async getBySignatureHash(signatureHash: string): Promise<SettlementRecord | null> {
    const stmt = this.db.prepare<[string], SettlementRow>(
      "SELECT * FROM settlements WHERE signature_hash = ?"
    );
    const row = stmt.get(signatureHash);
    if (!row) {
      return null;
    }
    return this.mapRowToRecord(row);
  }

  async updateStatus(
    id: string,
    status: SettlementStatus,
    details?: StatusUpdateDetails
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.getById(id);
    if (!existing) {
      return;
    }

    const txHash = details?.txHash !== undefined ? details.txHash : existing.txHash ?? null;
    const errorReason =
      details?.errorReason !== undefined ? details.errorReason : existing.errorReason ?? null;
    const errorCode =
      details?.errorCode !== undefined ? details.errorCode : existing.errorCode ?? null;

    const stmt = this.db.prepare(`
      UPDATE settlements SET
        status = ?,
        tx_hash = ?,
        error_reason = ?,
        error_code = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(status, txHash, errorReason, errorCode, now, id);
  }

  async list(filter?: SettlementFilter): Promise<SettlementRecord[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.payer) {
      conditions.push("payer = ?");
      params.push(filter.payer);
    }
    if (filter?.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }

    let query = "SELECT * FROM settlements";
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += " ORDER BY created_at ASC";

    if (filter?.limit !== undefined) {
      query += " LIMIT ?";
      params.push(filter.limit);
      if (filter?.offset !== undefined) {
        query += " OFFSET ?";
        params.push(filter.offset);
      }
    } else if (filter?.offset !== undefined) {
      query += " LIMIT -1 OFFSET ?";
      params.push(filter.offset);
    }

    const stmt = this.db.prepare<unknown[], SettlementRow>(query);
    const rows = stmt.all(...params);
    return rows.map((r) => this.mapRowToRecord(r));
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }
  }
}
