import { Transaction, Address } from "@multiversx/sdk-core";
import { ApiNetworkProvider } from "@multiversx/sdk-network-providers";

/**
 * Result of simulating a transaction on the MultiversX network.
 */
export interface ISimulationResult {
  status: "success" | "fail" | "failed" | "executed" | string;
  failReason?: string;
  returnCode?: string;
  returnMessage?: string;
  raw?: Record<string, unknown>;
  receiver?: string;
  sender?: string;
}

/**
 * Interface for MultiversX network provider operations used by the gateway.
 */
export interface INetworkProvider {
  /**
   * Simulates transaction execution without committing state.
   */
  simulateTransaction(tx: Transaction): Promise<ISimulationResult>;

  /**
   * Broadcasts a signed transaction to the network.
   */
  sendTransaction(tx: Transaction): Promise<string>;

  /**
   * Fetches transaction status and details by hash.
   */
  getTransaction(txHash: string): Promise<unknown>;

  /**
   * Fetches account details (nonce, balance) for an address.
   */
  getAccount(address: Address): Promise<unknown>;
}

/**
 * Adapter for MultiversX SDK ApiNetworkProvider to adhere to INetworkProvider.
 */
export class MvxApiNetworkProvider implements INetworkProvider {
  private readonly provider: ApiNetworkProvider;

  constructor(apiUrlOrProvider: string | ApiNetworkProvider, options?: { timeout?: number; clientName?: string }) {
    if (typeof apiUrlOrProvider === "string") {
      this.provider = new ApiNetworkProvider(apiUrlOrProvider, options);
    } else {
      this.provider = apiUrlOrProvider;
    }
  }

  async simulateTransaction(tx: Transaction): Promise<ISimulationResult> {
    try {
      const res = await this.provider.simulateTransaction(tx);
      return {
        status: res?.status ?? "success",
        returnCode: res?.returnCode ?? "ok",
        returnMessage: res?.returnMessage,
        raw: res,
      };
    } catch (err: any) {
      return {
        status: "fail",
        failReason: err?.message ?? String(err),
      };
    }
  }

  async sendTransaction(tx: Transaction): Promise<string> {
    return await this.provider.sendTransaction(tx);
  }

  async getTransaction(txHash: string): Promise<unknown> {
    return await this.provider.getTransaction(txHash);
  }

  async getAccount(address: Address): Promise<unknown> {
    const iAddress = {
      bech32: () => address.toBech32(),
    };
    return await this.provider.getAccount(iAddress);
  }
}
