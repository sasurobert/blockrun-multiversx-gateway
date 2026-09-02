import { PaymentErrorCode } from "../domain/types.js";

/**
 * Lifecycle status of a payment settlement.
 */
export type SettlementStatus = "pending" | "completed" | "failed";

/**
 * Record representing a settlement attempt in persistent storage.
 */
export interface SettlementRecord {
  id: string;
  signatureHash: string;
  payer: string;
  receiver: string;
  asset: string;
  amount: string;
  status: SettlementStatus;
  txHash?: string;
  errorReason?: string;
  errorCode?: PaymentErrorCode | string;
  createdAt: number;
  updatedAt: number;
  validBefore?: number;
}

/**
 * Query filter options for querying settlement records.
 */
export interface SettlementFilter {
  payer?: string;
  status?: SettlementStatus;
  limit?: number;
  offset?: number;
}

/**
 * Optional update fields when updating a settlement's status.
 */
export interface StatusUpdateDetails {
  txHash?: string;
  errorReason?: string;
  errorCode?: PaymentErrorCode | string;
}

/**
 * Interface for settlement record storage backends.
 */
export interface ISettlementStorage {
  /**
   * Saves a new settlement record to storage.
   */
  save(record: SettlementRecord): Promise<void>;

  /**
   * Retrieves a settlement record by its unique ID.
   */
  getById(id: string): Promise<SettlementRecord | null>;

  /**
   * Retrieves a settlement record by the SHA-256 hash of its transaction signature.
   */
  getBySignatureHash(signatureHash: string): Promise<SettlementRecord | null>;

  /**
   * Updates the status and associated result fields of an existing settlement record.
   */
  updateStatus(
    id: string,
    status: SettlementStatus,
    details?: StatusUpdateDetails
  ): Promise<void>;

  /**
   * Lists settlement records matching optional filter criteria.
   */
  list(filter?: SettlementFilter): Promise<SettlementRecord[]>;

  /**
   * Closes or cleans up any underlying resources/connections.
   */
  close(): Promise<void>;
}
