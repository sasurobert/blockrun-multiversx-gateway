import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { UserPublicKey, UserVerifier } from "@multiversx/sdk-wallet";
import {
  PaymentErrorCode,
  VerifyRequest,
  VerifyResponse,
  MvxTransactionPayload,
} from "../domain/types.js";
import { INetworkProvider } from "../domain/network.js";
import { RelayerPoolManager } from "./relayer_pool.js";
import { extractChainID, parseTransactionTransfers } from "../utils/data_parser.js";

/**
 * Maximum allowed gas price (2 Gwei / 2,000,000,000) to protect relayer wallets from drain attacks.
 */
export const MAX_ALLOWED_GAS_PRICE = 2_000_000_000n;

/**
 * Maximum allowed gas limit for relayer transactions (1,000,000 units) to prevent gas griefing.
 */
export const MAX_ALLOWED_RELAYER_GAS_LIMIT = 1_000_000n;

/**
 * Configuration options for VerifierService.
 */
export interface VerifierConfig {
  relayerPool?: RelayerPoolManager;
  networkProvider?: INetworkProvider;
}

/**
 * Interface defining x402 payment verification service operations.
 */
export interface IVerifierService {
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  getRelayerPool?(): RelayerPoolManager | undefined;
}

/**
 * Service responsible for validating x402 v2 payment payloads on MultiversX.
 */
export class VerifierService implements IVerifierService {
  private readonly relayerPool?: RelayerPoolManager;
  private readonly networkProvider?: INetworkProvider;
  private readonly transactionComputer: TransactionComputer;

  constructor(config?: VerifierConfig) {
    this.relayerPool = config?.relayerPool;
    this.networkProvider = config?.networkProvider;
    this.transactionComputer = new TransactionComputer();
  }

  /**
   * Returns the configured relayer pool manager if available.
   */
  public getRelayerPool(): RelayerPoolManager | undefined {
    return this.relayerPool;
  }

  /**
   * Verifies an x402 v2 payment payload against requested payment requirements.
   */
  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const { paymentPayload, paymentRequirements } = request;

    // 1. Extract transaction payload
    const rawPayload = paymentPayload.payload;
    const txPayload: MvxTransactionPayload =
      "transaction" in rawPayload ? rawPayload.transaction : rawPayload;

    // 2. Validate accepted requirements match requested requirements
    const accepted = paymentPayload.accepted;
    if (
      accepted.scheme !== paymentRequirements.scheme ||
      accepted.network !== paymentRequirements.network ||
      accepted.asset !== paymentRequirements.asset ||
      BigInt(accepted.amount) < BigInt(paymentRequirements.amount) ||
      accepted.payTo !== paymentRequirements.payTo
    ) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: "Accepted requirements do not match requested payment requirements",
        payer: txPayload.sender,
      };
    }

    // 3. Network / ChainID compatibility
    const expectedChainID = extractChainID(paymentRequirements.network);
    if (expectedChainID && txPayload.chainID !== expectedChainID) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Network mismatch: expected chainID ${expectedChainID}, got ${txPayload.chainID}`,
        payer: txPayload.sender,
      };
    }

    // 3b. Gas Price & Relayer Gas Limit Security Bounds (SEC-02)
    try {
      if (BigInt(txPayload.gasPrice) > MAX_ALLOWED_GAS_PRICE) {
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: `gasPrice ${txPayload.gasPrice} exceeds maximum allowed (${MAX_ALLOWED_GAS_PRICE})`,
          payer: txPayload.sender,
        };
      }

      if (txPayload.relayer && BigInt(txPayload.gasLimit) > MAX_ALLOWED_RELAYER_GAS_LIMIT) {
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: `gasLimit ${txPayload.gasLimit} exceeds maximum allowed relayer gas limit (${MAX_ALLOWED_RELAYER_GAS_LIMIT})`,
          payer: txPayload.sender,
        };
      }
    } catch {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: "Invalid integer format for gasPrice or gasLimit",
        payer: txPayload.sender,
      };
    }

    // 4. Time Window Checks
    const now = Math.floor(Date.now() / 1000);
    if (txPayload.validBefore !== undefined && txPayload.validBefore <= now) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_EXPIRED,
        invalidReason: `Transaction has expired: validBefore ${txPayload.validBefore} is in the past`,
        payer: txPayload.sender,
      };
    }

    if (txPayload.validAfter !== undefined && txPayload.validAfter > now) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Transaction is not yet valid: validAfter ${txPayload.validAfter} is in the future`,
        payer: txPayload.sender,
      };
    }

    // 5. Parse Transfers
    let transfers;
    try {
      transfers = parseTransactionTransfers(txPayload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Failed to parse transaction transfers: ${message}`,
        payer: txPayload.sender,
      };
    }

    if (transfers.length === 0) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: "No valid pure transfer details found in transaction payload",
        payer: txPayload.sender,
      };
    }

    // Find transfer matching the requested asset
    const matchingAssetTransfer = transfers.find((t) => t.asset === paymentRequirements.asset);
    if (!matchingAssetTransfer) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Asset mismatch: expected ${paymentRequirements.asset}, but transaction transferred [${transfers.map((t) => t.asset).join(", ")}]`,
        payer: txPayload.sender,
      };
    }

    // Check receiver
    if (matchingAssetTransfer.receiver !== paymentRequirements.payTo) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Receiver mismatch: expected ${paymentRequirements.payTo}, got ${matchingAssetTransfer.receiver}`,
        payer: txPayload.sender,
      };
    }

    // Check amount
    if (BigInt(matchingAssetTransfer.amount) < BigInt(paymentRequirements.amount)) {
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_UNFUNDED,
        invalidReason: `Insufficient payment amount: expected ${paymentRequirements.amount}, got ${matchingAssetTransfer.amount}`,
        payer: txPayload.sender,
      };
    }

    // 6. Cryptographic Signature Verification
    let senderAddr: Address;
    let receiverAddr: Address;
    let relayerAddr: Address | undefined;
    let guardianAddr: Address | undefined;

    try {
      senderAddr = Address.newFromBech32(txPayload.sender);
      receiverAddr = Address.newFromBech32(txPayload.receiver);
      relayerAddr = txPayload.relayer ? Address.newFromBech32(txPayload.relayer) : undefined;
      guardianAddr = txPayload.guardian ? Address.newFromBech32(txPayload.guardian) : undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Invalid bech32 address format in transaction payload: ${message}`,
        payer: txPayload.sender,
      };
    }

    const tx = new Transaction({
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

    if (txPayload.relayerSignature) {
      tx.relayerSignature = Buffer.from(txPayload.relayerSignature, "hex");
    }
    if (txPayload.guardianSignature) {
      tx.guardianSignature = Buffer.from(txPayload.guardianSignature, "hex");
    }

    try {
      const bytesToVerify = this.transactionComputer.computeBytesForVerifying(tx);
      const userVerifier = new UserVerifier(new UserPublicKey(senderAddr.getPublicKey()));
      const isUserSignatureValid = userVerifier.verify(bytesToVerify, tx.signature);

      if (!isUserSignatureValid) {
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: "Invalid transaction signature from sender",
          payer: txPayload.sender,
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
        invalidReason: `Failed to verify sender signature: ${message}`,
        payer: txPayload.sender,
      };
    }

    // 6b. Guardian Signature Verification (SEC-04)
    if (txPayload.guardian && guardianAddr) {
      if (!txPayload.guardianSignature) {
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: "Missing required guardian signature for guarded transaction",
          payer: txPayload.sender,
        };
      }

      try {
        const bytesToVerify = this.transactionComputer.computeBytesForVerifying(tx);
        const guardianVerifier = new UserVerifier(new UserPublicKey(guardianAddr.getPublicKey()));
        const isGuardianSignatureValid = guardianVerifier.verify(bytesToVerify, tx.guardianSignature);

        if (!isGuardianSignatureValid) {
          return {
            isValid: false,
            errorCode: PaymentErrorCode.PAYMENT_INVALID,
            invalidReason: "Invalid guardian signature on transaction",
            payer: txPayload.sender,
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: `Failed to verify guardian signature: ${message}`,
          payer: txPayload.sender,
        };
      }
    }

    // 7. Relayed V3 Verification
    if (txPayload.relayer) {
      if (this.relayerPool) {
        let expectedRelayer: string;
        try {
          expectedRelayer = this.relayerPool.getRelayerAddressForUser(txPayload.sender);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isValid: false,
            errorCode: PaymentErrorCode.PAYMENT_INVALID,
            invalidReason: `Failed to resolve relayer for sender shard: ${message}`,
            payer: txPayload.sender,
          };
        }

        if (txPayload.relayer !== expectedRelayer) {
          return {
            isValid: false,
            errorCode: PaymentErrorCode.PAYMENT_INVALID,
            invalidReason: `Relayer address mismatch for user shard: expected ${expectedRelayer}, got ${txPayload.relayer}`,
            payer: txPayload.sender,
          };
        }
      }

      if (txPayload.relayerSignature && relayerAddr) {
        try {
          const bytesToVerify = this.transactionComputer.computeBytesForVerifying(tx);
          const relayerVerifier = new UserVerifier(new UserPublicKey(relayerAddr.getPublicKey()));
          const isRelayerSignatureValid = relayerVerifier.verify(bytesToVerify, tx.relayerSignature);

          if (!isRelayerSignatureValid) {
            return {
              isValid: false,
              errorCode: PaymentErrorCode.PAYMENT_INVALID,
              invalidReason: "Invalid relayer signature on transaction",
              payer: txPayload.sender,
            };
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isValid: false,
            errorCode: PaymentErrorCode.PAYMENT_INVALID,
            invalidReason: `Failed to verify relayer signature: ${message}`,
            payer: txPayload.sender,
          };
        }
      }
    }

    // 8. Network Simulation (if networkProvider provided)
    if (this.networkProvider) {
      try {
        let txToSimulate = tx;
        // SEC-03: If Relayed V3 and missing relayer signature, temporarily countersign for simulation
        if (txPayload.relayer && !txPayload.relayerSignature && this.relayerPool) {
          try {
            const relayerSigner = this.relayerPool.getRelayerForAddress(txPayload.sender);
            const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
            const relayerSig = await relayerSigner.sign(bytesToSign);
            txToSimulate = new Transaction({
              nonce: tx.nonce,
              value: tx.value,
              sender: tx.sender,
              receiver: tx.receiver,
              gasPrice: tx.gasPrice,
              gasLimit: tx.gasLimit,
              data: tx.data,
              chainID: tx.chainID,
              version: tx.version,
              options: tx.options,
              relayer: tx.relayer,
              guardian: tx.guardian,
            });
            txToSimulate.signature = tx.signature;
            txToSimulate.relayerSignature = relayerSig;
            if (tx.guardianSignature) {
              txToSimulate.guardianSignature = tx.guardianSignature;
            }
          } catch {
            // Fallback to original tx if relayer signing fails
          }
        }

        const simResult = await this.networkProvider.simulateTransaction(txToSimulate);
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

          return {
            isValid: false,
            errorCode: isUnfunded
              ? PaymentErrorCode.PAYMENT_UNFUNDED
              : PaymentErrorCode.PAYMENT_INVALID,
            invalidReason: reason,
            payer: txPayload.sender,
          };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isValid: false,
          errorCode: PaymentErrorCode.PAYMENT_INVALID,
          invalidReason: `Network simulation error: ${message}`,
          payer: txPayload.sender,
        };
      }
    }

    return {
      isValid: true,
      payer: txPayload.sender,
    };
  }
}
