import crypto from "crypto";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import {
  PaymentErrorCode,
  SettleRequest,
  SettleResponse,
  MvxTransactionPayload,
} from "../domain/types.js";
import { INetworkProvider } from "../domain/network.js";
import { ISettlementStorage, SettlementRecord } from "../storage/types.js";
import { RelayerPoolManager } from "./relayer_pool.js";
import { IVerifierService, VerifierService } from "./verifier.js";

/**
 * Configuration options for SettlerService.
 */
export interface SettlerConfig {
  storage: ISettlementStorage;
  networkProvider: INetworkProvider;
  verifier?: IVerifierService;
  relayerPool?: RelayerPoolManager;
  simulateBeforeBroadcast?: boolean;
}

/**
 * Interface defining settlement service operations.
 */
export interface ISettlerService {
  settle(request: SettleRequest): Promise<SettleResponse>;
  getSettlement(signatureHash: string): Promise<SettlementRecord | null>;
}

/**
 * Service responsible for executing and persisting x402 payment settlements on MultiversX.
 */
export class SettlerService implements ISettlerService {
  private readonly storage: ISettlementStorage;
  private readonly networkProvider: INetworkProvider;
  private readonly verifier: IVerifierService;
  private readonly relayerPool?: RelayerPoolManager;
  private readonly simulateBeforeBroadcast: boolean;
  private readonly transactionComputer: TransactionComputer;

  constructor(config: SettlerConfig) {
    this.storage = config.storage;
    this.networkProvider = config.networkProvider;
    this.relayerPool = config.relayerPool;
    this.verifier =
      config.verifier ??
      new VerifierService({
        relayerPool: this.relayerPool,
        networkProvider: this.networkProvider,
      });
    this.simulateBeforeBroadcast = config.simulateBeforeBroadcast ?? false;
    this.transactionComputer = new TransactionComputer();
  }

  /**
   * Computes the SHA-256 hash of a transaction signature hex string.
   */
  public computeSignatureHash(signature: string): string {
    return crypto.createHash("sha256").update(signature).digest("hex");
  }

  /**
   * Retrieves a settlement record by signature hash.
   */
  async getSettlement(signatureHash: string): Promise<SettlementRecord | null> {
    return this.storage.getBySignatureHash(signatureHash);
  }

  /**
   * Settles an x402 v2 payment request.
   */
  async settle(request: SettleRequest): Promise<SettleResponse> {
    const { paymentPayload, paymentRequirements } = request;

    // 1. Extract transaction payload
    const rawPayload = paymentPayload.payload;
    const txPayload: MvxTransactionPayload =
      "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

    // 2. Compute signature hash for idempotency
    const sigHash = this.computeSignatureHash(txPayload.signature);

    // 3. Check for existing completed settlement
    const existing = await this.storage.getBySignatureHash(sigHash);
    if (existing && existing.status === "completed" && existing.txHash) {
      return {
        success: true,
        transaction: existing.txHash,
        network: paymentRequirements.network,
        payer: existing.payer,
      };
    }

    // 4. Verify payment validity
    const verifyResult = await this.verifier.verify({
      paymentPayload,
      paymentRequirements,
    });

    if (!verifyResult.isValid) {
      const recordId = existing?.id ?? crypto.randomUUID();
      const failedRecord: SettlementRecord = {
        id: recordId,
        signatureHash: sigHash,
        payer: txPayload.sender,
        receiver: paymentRequirements.payTo,
        asset: paymentRequirements.asset,
        amount: paymentRequirements.amount,
        status: "failed",
        errorReason: verifyResult.invalidReason,
        errorCode: verifyResult.errorCode ?? PaymentErrorCode.PAYMENT_INVALID,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        validBefore: txPayload.validBefore,
      };
      await this.storage.save(failedRecord);

      return {
        success: false,
        errorReason: verifyResult.invalidReason,
        errorCode: verifyResult.errorCode ?? PaymentErrorCode.PAYMENT_INVALID,
        network: paymentRequirements.network,
        payer: verifyResult.payer ?? txPayload.sender,
      };
    }

    // 5. Initialize or update record as pending
    const recordId = existing?.id ?? crypto.randomUUID();
    const pendingRecord: SettlementRecord = {
      id: recordId,
      signatureHash: sigHash,
      payer: txPayload.sender,
      receiver: paymentRequirements.payTo,
      asset: paymentRequirements.asset,
      amount: paymentRequirements.amount,
      status: "pending",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      validBefore: txPayload.validBefore,
    };
    await this.storage.save(pendingRecord);

    // 6. Build MultiversX Transaction
    let tx: Transaction;
    try {
      const senderAddr = Address.newFromBech32(txPayload.sender);
      const receiverAddr = Address.newFromBech32(txPayload.receiver);
      let relayerAddr = txPayload.relayer ? Address.newFromBech32(txPayload.relayer) : undefined;
      const guardianAddr = txPayload.guardian ? Address.newFromBech32(txPayload.guardian) : undefined;

      // Auto-populate relayer address from pool if relayer pool is available and transaction is Relayed V3
      if (!relayerAddr && this.relayerPool && (txPayload.version === 2 || txPayload.relayer !== undefined)) {
        const relayerAddrStr = this.relayerPool.getRelayerAddressForUser(txPayload.sender);
        relayerAddr = Address.newFromBech32(relayerAddrStr);
      }

      tx = new Transaction({
        nonce: BigInt(txPayload.nonce),
        value: BigInt(txPayload.value),
        sender: senderAddr,
        receiver: receiverAddr,
        gasPrice: BigInt(txPayload.gasPrice),
        gasLimit: BigInt(txPayload.gasLimit),
        data: txPayload.data ? Buffer.from(txPayload.data) : Buffer.from(""),
        chainID: txPayload.chainID,
        version: txPayload.version,
        options: txPayload.options,
        relayer: relayerAddr,
        guardian: guardianAddr,
      });
      tx.signature = Buffer.from(txPayload.signature, "hex");

      if (txPayload.guardianSignature) {
        tx.guardianSignature = Buffer.from(txPayload.guardianSignature, "hex");
      }

      // 7. Handle Relayer Signature
      if (txPayload.relayerSignature) {
        tx.relayerSignature = Buffer.from(txPayload.relayerSignature, "hex");
      } else if (relayerAddr && this.relayerPool) {
        // Automatically sign with sender shard relayer key from pool
        const relayerSigner = this.relayerPool.getRelayerForAddress(txPayload.sender);
        const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
        const relayerSig = await relayerSigner.sign(bytesToSign);
        tx.relayerSignature = relayerSig;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.storage.updateStatus(recordId, "failed", {
        errorReason: `Transaction construction failed: ${message}`,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
      });

      return {
        success: false,
        errorReason: `Transaction construction failed: ${message}`,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        network: paymentRequirements.network,
        payer: txPayload.sender,
      };
    }

    // 8. Pre-broadcast simulation check if configured
    if (this.simulateBeforeBroadcast) {
      try {
        const simResult = await this.networkProvider.simulateTransaction(tx);
        const statusLower = simResult.status?.toLowerCase();
        const returnCodeLower = simResult.returnCode?.toLowerCase();

        const isSuccess =
          statusLower === "success" ||
          statusLower === "executed" ||
          returnCodeLower === "ok" ||
          returnCodeLower === "success";

        if (!isSuccess) {
          const reason =
            simResult.failReason || simResult.returnMessage || "Simulation failed on network";
          const reasonLower = reason.toLowerCase();
          const isUnfunded =
            reasonLower.includes("funds") ||
            reasonLower.includes("balance") ||
            reasonLower.includes("unfunded") ||
            reasonLower.includes("insufficient");

          const errorCode = isUnfunded
            ? PaymentErrorCode.PAYMENT_UNFUNDED
            : PaymentErrorCode.PAYMENT_INVALID;

          await this.storage.updateStatus(recordId, "failed", {
            errorReason: reason,
            errorCode,
          });

          return {
            success: false,
            errorReason: reason,
            errorCode,
            network: paymentRequirements.network,
            payer: txPayload.sender,
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await this.storage.updateStatus(recordId, "failed", {
          errorReason: `Simulation error: ${message}`,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
        });

        return {
          success: false,
          errorReason: `Simulation error: ${message}`,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          network: paymentRequirements.network,
          payer: txPayload.sender,
        };
      }
    }

    // 9. Broadcast transaction to MultiversX network
    try {
      const txHash = await this.networkProvider.sendTransaction(tx);

      // 10. Update storage record to completed
      await this.storage.updateStatus(recordId, "completed", {
        txHash,
      });

      return {
        success: true,
        transaction: txHash,
        network: paymentRequirements.network,
        payer: txPayload.sender,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const msgLower = message.toLowerCase();
      const isUnfunded =
        msgLower.includes("funds") ||
        msgLower.includes("balance") ||
        msgLower.includes("insufficient");

      const errorCode = isUnfunded
        ? PaymentErrorCode.PAYMENT_UNFUNDED
        : PaymentErrorCode.PAYMENT_INVALID;

      await this.storage.updateStatus(recordId, "failed", {
        errorReason: `Broadcast failed: ${message}`,
        errorCode,
      });

      return {
        success: false,
        errorReason: `Broadcast failed: ${message}`,
        errorCode,
        network: paymentRequirements.network,
        payer: txPayload.sender,
      };
    }
  }
}
