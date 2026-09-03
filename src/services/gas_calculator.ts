/**
 * MultiversX Exact Gas Calculation Engine
 *
 * Implements the exact MultiversX protocol gas formulas per network configuration
 * and multiversx-sc / sdk-core specifications.
 *
 * Eliminates VM warnings: "@too much gas provided for processing: gas provided = ..., gas used = 200000".
 */

export interface GasCalculationParams {
  /**
   * Data payload string, Buffer, or Uint8Array.
   */
  data?: string | Uint8Array | Buffer;

  /**
   * True if the transaction is relayed (Relayed V1, V2, or V3).
   * Adds erd_extra_gas_limit_relayed_tx (default: 50,000).
   */
  isRelayed?: boolean;

  /**
   * True if the transaction is guarded by a guardian.
   * Adds erd_extra_gas_limit_guarded_tx (default: 50,000).
   */
  isGuarded?: boolean;

  /**
   * Gas price in atomic units (default: 1,000,000,000 = 1 Gwei).
   */
  gasPrice?: bigint;

  /**
   * Optional custom execution gas (for smart contract endpoint execution).
   * If not provided, will be determined automatically by parsing the data payload.
   */
  customExecutionGas?: bigint | number;
}

export interface GasCalculationResult {
  /**
   * The exact total gas limit to set on the transaction.
   */
  gasLimit: bigint;

  /**
   * Base movement gas (minGasLimit + dataGas + extraGas).
   */
  moveGas: bigint;

  /**
   * Gas dedicated for VM / built-in function execution.
   */
  executionGas: bigint;

  /**
   * Gas charged strictly for data bytes (length * gasPerByte).
   */
  dataGas: bigint;

  /**
   * Total length of the data payload in bytes.
   */
  dataByteLength: number;

  /**
   * Gas price used.
   */
  gasPrice: bigint;

  /**
   * Total fee in atomic units (wei/atto-EGLD): gasLimit * gasPrice.
   */
  feeInWei: bigint;

  /**
   * Fee formatted in EGLD.
   */
  feeInEgld: string;
}

export class MultiversXGasCalculator {
  // Protocol Constants from network configuration
  public static readonly MIN_GAS_LIMIT = 50_000n;
  public static readonly GAS_PER_DATA_BYTE = 1_500n;
  public static readonly EXTRA_GAS_RELAYED_TX = 50_000n;
  public static readonly EXTRA_GAS_GUARDED_TX = 50_000n;

  // Built-in Function Execution Costs
  public static readonly ESDT_TRANSFER_COST = 200_000n;
  public static readonly ESDT_NFT_TRANSFER_COST = 200_000n;
  public static readonly MULTI_ESDT_NFT_TRANSFER_COST_PER_ITEM = 200_000n;

  // Default Gas Price
  public static readonly DEFAULT_GAS_PRICE = 1_000_000_000n; // 1 Gwei

  /**
   * Calculates the exact gas limit and fee for any MultiversX transaction.
   */
  public static calculate(params: GasCalculationParams): GasCalculationResult {
    const dataBytes = this.normalizeData(params.data);
    const dataByteLength = dataBytes.length;
    const gasPrice = params.gasPrice ?? this.DEFAULT_GAS_PRICE;

    // 1. Data byte cost
    const dataGas = BigInt(dataByteLength) * this.GAS_PER_DATA_BYTE;

    // 2. Extra protocol costs
    let extraGas = 0n;
    if (params.isRelayed) {
      extraGas += this.EXTRA_GAS_RELAYED_TX;
    }
    if (params.isGuarded) {
      extraGas += this.EXTRA_GAS_GUARDED_TX;
    }

    // 3. Total move balance gas
    const moveGas = this.MIN_GAS_LIMIT + dataGas + extraGas;

    // 4. Execution gas
    let executionGas: bigint;
    if (params.customExecutionGas !== undefined) {
      executionGas = BigInt(params.customExecutionGas);
    } else {
      executionGas = this.determineExecutionGas(dataBytes);
    }

    // 5. Total exact gas limit
    const gasLimit = moveGas + executionGas;

    // 6. Fee computation
    const feeInWei = gasLimit * gasPrice;
    const feeInEgld = (Number(feeInWei) / 1e18).toFixed(6);

    return {
      gasLimit,
      moveGas,
      executionGas,
      dataGas,
      dataByteLength,
      gasPrice,
      feeInWei,
      feeInEgld,
    };
  }

  /**
   * High-level helper specifically for single ESDT transfers (e.g. USDC payment).
   *
   * @param tokenId Token identifier (e.g. "USDC-350c4e" or "USDC-c76f1f")
   * @param amountMicro Amount in token atomic units (e.g. 1000000 for 1 USDC)
   * @param isRelayed True if relayed transaction (default: true)
   */
  public static forEsdtTransfer(
    tokenId: string,
    amountMicro: bigint | number | string,
    isRelayed: boolean = true
  ): GasCalculationResult {
    let hexAmount = BigInt(amountMicro).toString(16);
    if (hexAmount.length % 2 !== 0) {
      hexAmount = "0" + hexAmount;
    }
    const tokenHex = Buffer.from(tokenId).toString("hex");
    const dataString = `ESDTTransfer@${tokenHex}@${hexAmount}`;

    return this.calculate({
      data: dataString,
      isRelayed,
      customExecutionGas: this.ESDT_TRANSFER_COST,
    });
  }

  /**
   * Helper for multiple ESDT transfers in a single transaction.
   */
  public static forMultiEsdtTransfer(
    numberOfTokens: number,
    dataPayloadLength: number,
    isRelayed: boolean = true
  ): GasCalculationResult {
    const executionGas = this.MULTI_ESDT_NFT_TRANSFER_COST_PER_ITEM * BigInt(numberOfTokens);
    return this.calculate({
      data: new Uint8Array(dataPayloadLength),
      isRelayed,
      customExecutionGas: executionGas,
    });
  }

  /**
   * Inspects transaction data to determine exact execution gas needed.
   */
  private static determineExecutionGas(dataBytes: Uint8Array): bigint {
    if (dataBytes.length === 0) {
      return 0n; // Plain native transfer
    }

    const dataString = Buffer.from(dataBytes).toString("utf-8");

    if (dataString.startsWith("ESDTTransfer@")) {
      const parts = dataString.split("@");
      // Standard ESDTTransfer@token@amount
      if (parts.length === 3) {
        return this.ESDT_TRANSFER_COST;
      }
      // ESDTTransfer with contract call: ESDTTransfer@token@amount@endpoint@arg...
      // Requires caller to pass customExecutionGas, or default to standard SC call budget
      return this.ESDT_TRANSFER_COST;
    }

    if (dataString.startsWith("ESDTNFTTransfer@")) {
      return this.ESDT_NFT_TRANSFER_COST;
    }

    if (dataString.startsWith("MultiESDTNFTTransfer@")) {
      const parts = dataString.split("@");
      if (parts.length >= 3) {
        const numTokensHex = parts[2];
        const numTokens = parseInt(numTokensHex, 16) || 1;
        return this.MULTI_ESDT_NFT_TRANSFER_COST_PER_ITEM * BigInt(numTokens);
      }
      return this.MULTI_ESDT_NFT_TRANSFER_COST_PER_ITEM;
    }

    // Default for plain data or unknown payload
    return 0n;
  }

  private static normalizeData(data?: string | Uint8Array | Buffer): Uint8Array {
    if (!data) return new Uint8Array(0);
    if (typeof data === "string") {
      return Buffer.from(data, "utf-8");
    }
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
}
