import { Address } from "@multiversx/sdk-core";
import { MvxTransactionPayload } from "../domain/types.js";

/**
 * Parsed transfer details from a transaction payload.
 */
export interface ParsedTransfer {
  type: "EGLD" | "ESDT" | "ESDTNFT" | "MultiESDTNFT";
  asset: string;
  amount: string;
  receiver: string;
  sender: string;
  nonce?: number;
}

/**
 * Builds the data payload for an ESDTTransfer transaction.
 */
export function buildEsdtTransferData(tokenIdentifier: string, amount: string | bigint): string {
  const tokenHex = Buffer.from(tokenIdentifier, "utf8").toString("hex");
  let amountHex = BigInt(amount).toString(16);
  if (amountHex.length % 2 !== 0) {
    amountHex = "0" + amountHex;
  }
  return `ESDTTransfer@${tokenHex}@${amountHex}`;
}

/**
 * Builds the data payload for a MultiESDTNFTTransfer transaction.
 */
export function buildMultiEsdtTransferData(
  receiverAddress: string,
  transfers: Array<{ tokenIdentifier: string; amount: string | bigint; nonce?: number }>
): string {
  const receiverHex = Address.newFromBech32(receiverAddress).toHex();
  let countHex = transfers.length.toString(16);
  if (countHex.length % 2 !== 0) {
    countHex = "0" + countHex;
  }

  const parts = ["MultiESDTNFTTransfer", receiverHex, countHex];

  for (const transfer of transfers) {
    const tokenHex = Buffer.from(transfer.tokenIdentifier, "utf8").toString("hex");
    let nonceHex = (transfer.nonce ?? 0).toString(16);
    if (nonceHex.length % 2 !== 0) {
      nonceHex = "0" + nonceHex;
    }
    let amountHex = BigInt(transfer.amount).toString(16);
    if (amountHex.length % 2 !== 0) {
      amountHex = "0" + amountHex;
    }

    parts.push(tokenHex, nonceHex, amountHex);
  }

  return parts.join("@");
}

/**
 * Decodes raw transaction data string from utf-8 or base64.
 */
export function decodeTransactionData(data?: string): string | undefined {
  if (!data || data.length === 0) {
    return undefined;
  }

  if (
    data.startsWith("ESDTTransfer@") ||
    data.startsWith("ESDTNFTTransfer@") ||
    data.startsWith("MultiESDTNFTTransfer@")
  ) {
    return data;
  }

  // Attempt base64 decode
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    if (
      decoded.startsWith("ESDTTransfer@") ||
      decoded.startsWith("ESDTNFTTransfer@") ||
      decoded.startsWith("MultiESDTNFTTransfer@")
    ) {
      return decoded;
    }
  } catch {
    // Keep original data
  }

  return data;
}

/**
 * Parses all transfers (native EGLD, ESDT, MultiESDT) contained within a transaction payload.
 */
export function parseTransactionTransfers(payload: MvxTransactionPayload): ParsedTransfer[] {
  const transfers: ParsedTransfer[] = [];

  try {
    // 1. Check native EGLD transfer
    if (payload.value && payload.value !== "0") {
      try {
        if (BigInt(payload.value) > 0n) {
          transfers.push({
            type: "EGLD",
            asset: "EGLD",
            amount: payload.value,
            receiver: payload.receiver,
            sender: payload.sender,
          });
        }
      } catch {
        // Invalid integer format in value
      }
    }

    // 2. Check ESDT / Smart Transfer Data
    const decodedData = decodeTransactionData(payload.data);
    if (decodedData) {
      const parts = decodedData.split("@");
      const funcName = parts[0];

      if (funcName === "ESDTTransfer" && parts.length >= 3) {
        try {
          const tokenIdentifier = Buffer.from(parts[1], "hex").toString("utf8");
          const amount = BigInt("0x" + (parts[2] || "0")).toString(10);
          transfers.push({
            type: "ESDT",
            asset: tokenIdentifier,
            amount: amount,
            receiver: payload.receiver,
            sender: payload.sender,
          });
        } catch {
          // Ignore corrupted ESDT transfer part
        }
      } else if (funcName === "ESDTNFTTransfer" && parts.length >= 5) {
        try {
          const tokenIdentifier = Buffer.from(parts[1], "hex").toString("utf8");
          const nonce = parseInt(parts[2] || "0", 16);
          const amount = BigInt("0x" + (parts[3] || "0")).toString(10);
          const receiver = Address.newFromHex(parts[4]).toBech32();
          transfers.push({
            type: "ESDTNFT",
            asset: tokenIdentifier,
            amount: amount,
            nonce: isNaN(nonce) ? 0 : nonce,
            receiver: receiver,
            sender: payload.sender,
          });
        } catch {
          // Ignore corrupted ESDTNFT transfer part
        }
      } else if (funcName === "MultiESDTNFTTransfer" && parts.length >= 6) {
        try {
          const receiver = Address.newFromHex(parts[1]).toBech32();
          const numTransfers = parseInt(parts[2] || "0", 16);

          for (let i = 0; i < (isNaN(numTransfers) ? 0 : numTransfers); i++) {
            const baseIdx = 3 + i * 3;
            if (parts.length >= baseIdx + 3) {
              try {
                const tokenIdentifier = Buffer.from(parts[baseIdx], "hex").toString("utf8");
                const nonce = parseInt(parts[baseIdx + 1] || "0", 16);
                const amount = BigInt("0x" + (parts[baseIdx + 2] || "0")).toString(10);

                transfers.push({
                  type: "MultiESDTNFT",
                  asset: tokenIdentifier,
                  amount: amount,
                  nonce: isNaN(nonce) ? 0 : nonce,
                  receiver: receiver,
                  sender: payload.sender,
                });
              } catch {
                // Ignore individual malformed transfer part
              }
            }
          }
        } catch {
          // Ignore malformed MultiESDTNFT payload
        }
      }
    }
  } catch {
    // Return whatever transfers were parsed safely
  }

  return transfers;
}

