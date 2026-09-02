import fs from "fs";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import {
  PaymentRequirements,
  X402PaymentPayload,
} from "../domain/types.js";
import { INetworkProvider } from "../domain/network.js";
import { buildEsdtTransferData } from "../utils/data_parser.js";
import {
  decodeHeaderJson,
  encodeHeaderJson,
} from "../utils/header_utils.js";
import {
  APIError,
  PaymentError,
  SpendLimitError,
} from "./errors.js";

/**
 * Message object for OpenAI-compatible chat format.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | string;
  content: string;
}

/**
 * Options for OpenAI-compatible chat requests.
 */
export interface ChatOptions {
  maxTokens?: number;
  max_tokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Standard OpenAI-compatible chat completion response.
 */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  paymentReceipt?: string;
  [key: string]: unknown;
}

/**
 * Message object for Anthropic-compatible format.
 */
export interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Options for Anthropic-compatible requests.
 */
export interface AnthropicOptions {
  system?: string;
  max_tokens?: number;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Anthropic-compatible message response.
 */
export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: Array<{ type: string; text: string; [key: string]: unknown }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  paymentReceipt?: string;
  [key: string]: unknown;
}

/**
 * Smart Chat routing metadata.
 */
export interface SmartChatRouting {
  tier: "eco" | "premium";
  savings: string;
  model: string;
}

/**
 * Smart Chat response with routing and payment receipt.
 */
export type SmartChatResponse = ChatCompletionResponse & {
  routing: SmartChatRouting;
};

/**
 * Configuration for BlockRun MultiversX Client SDK.
 */
export interface BlockRunClientConfig {
  gatewayUrl?: string;
  signer?: UserSigner;
  mnemonic?: string;
  pemPath?: string;
  network?: string;
  networkProvider?: INetworkProvider;
  maxCostPerCall?: number;
  maxCostPerCallUsd?: number;
  maxSessionCost?: number;
  maxSessionCostUsd?: number;
  relayerAddress?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Extracts chain ID from CAIP-like network string (e.g. multiversx:1 -> 1).
 */
function chainIDFromNetwork(network: string): string {
  if (network.includes(":")) {
    return network.split(":")[1];
  }
  return network;
}

/**
 * Autonomous MultiversX Agent Client SDK for BlockRun x402 AI Gateway.
 */
export class BlockRunMvxClient {
  private readonly gatewayUrl: string;
  private readonly signer: UserSigner;
  private readonly userAddress: Address;
  private readonly network: string;
  private readonly networkProvider?: INetworkProvider;
  private readonly maxCostPerCall?: number;
  private readonly maxSessionCost?: number;
  private readonly customFetch: typeof fetch;
  private readonly timeoutMs: number;
  private relayerAddress?: string;
  private sessionSpendUsd: number = 0;
  private localNonce: number = 0;
  private readonly transactionComputer: TransactionComputer;

  constructor(config: BlockRunClientConfig = {}) {
    this.gatewayUrl = (config.gatewayUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.network = config.network ?? "multiversx:1";
    this.networkProvider = config.networkProvider;
    this.maxCostPerCall = config.maxCostPerCall ?? config.maxCostPerCallUsd;
    this.maxSessionCost = config.maxSessionCost ?? config.maxSessionCostUsd;
    this.relayerAddress = config.relayerAddress;
    this.customFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.transactionComputer = new TransactionComputer();

    // 1. Initialize Signer
    if (config.signer) {
      this.signer = config.signer;
    } else if (config.mnemonic) {
      const mn = Mnemonic.fromString(config.mnemonic.trim());
      this.signer = new UserSigner(mn.deriveKey(0));
    } else if (config.pemPath) {
      const pemContent = fs.readFileSync(config.pemPath, "utf8");
      this.signer = UserSigner.fromPem(pemContent);
    } else {
      // Default to newly generated wallet for autonomous agents if none provided
      const mn = Mnemonic.generate();
      this.signer = new UserSigner(mn.deriveKey(0));
    }

    this.userAddress = Address.newFromBech32(this.signer.getAddress().bech32());
  }

  /**
   * Returns the agent's MultiversX bech32 address.
   */
  public getWalletAddress(): string {
    return this.userAddress.toBech32();
  }

  /**
   * Returns current session cumulative spend in USD.
   */
  public getSessionSpend(): number {
    return this.sessionSpendUsd;
  }

  /**
   * Returns account native balance in atomic units from network provider if available.
   */
  public async getBalance(): Promise<string> {
    if (this.networkProvider) {
      const account = (await this.networkProvider.getAccount(this.userAddress)) as {
        balance?: string | bigint;
      };
      return account?.balance ? account.balance.toString() : "0";
    }
    return "0";
  }

  /**
   * Resolves relayer address for the agent's shard from gateway or cache.
   */
  private async resolveRelayerAddress(): Promise<string> {
    if (this.relayerAddress) {
      return this.relayerAddress;
    }

    try {
      const url = `${this.gatewayUrl}/relayer/address/${this.userAddress.toBech32()}`;
      const res = await this.customFetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const data = (await res.json()) as { relayerAddress?: string };
        if (data.relayerAddress) {
          this.relayerAddress = data.relayerAddress;
          return data.relayerAddress;
        }
      }
    } catch {
      // Fall through to default fallback
    }

    return this.userAddress.toBech32();
  }

  /**
   * Resolves the current account nonce for signing transactions.
   */
  private async getAccountNonce(): Promise<number> {
    if (this.networkProvider) {
      try {
        const account = (await this.networkProvider.getAccount(this.userAddress)) as {
          nonce?: number;
        };
        if (account?.nonce !== undefined) {
          this.localNonce = Math.max(this.localNonce, account.nonce);
        }
      } catch {
        // Fall back to localNonce tracker
      }
    }
    const current = this.localNonce;
    this.localNonce++;
    return current;
  }

  /**
   * Core autonomous 402 payment execution loop.
   */
  private async executeWith402Payment<T extends Record<string, unknown>>(
    endpoint: string,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): Promise<T & { paymentReceipt?: string }> {
    const url = `${this.gatewayUrl}${endpoint}`;
    const initialHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    };

    // Step 1: Send initial unpaid request
    let res = await this.customFetch(url, {
      method: "POST",
      headers: initialHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // Step 2: If 200 OK -> return response directly
    if (res.status === 200 || res.ok) {
      const data = (await res.json()) as T;
      const receipt = this.extractReceipt(res, data);
      return {
        ...data,
        ...(receipt ? { paymentReceipt: receipt } : {}),
      };
    }

    // Step 3: Handle 402 Payment Required challenge
    if (res.status === 402) {
      const requirement = await this.extractPaymentRequirements(res);
      if (!requirement) {
        throw new PaymentError("Received 402 Payment Required, but failed to parse payment requirements");
      }

      // Step 4: Enforce spend limits
      const decimals = typeof (requirement.extra as any)?.decimals === "number" ? (requirement.extra as any).decimals : 6;
      let costUsd = 0;
      try {
        const rawAmount = BigInt(requirement.amount);
        const divisor = 10n ** BigInt(decimals);
        costUsd = Number(rawAmount) / Number(divisor);
      } catch {
        costUsd = parseInt(requirement.amount, 10) / (10 ** decimals);
      }

      if (this.maxCostPerCall !== undefined && costUsd > this.maxCostPerCall) {
        throw new SpendLimitError(
          `Requested call cost ($${costUsd.toFixed(6)}) exceeds maxCostPerCall limit ($${this.maxCostPerCall.toFixed(6)})`,
          "call",
          costUsd,
          this.maxCostPerCall
        );
      }

      if (this.maxSessionCost !== undefined && this.sessionSpendUsd + costUsd > this.maxSessionCost) {
        throw new SpendLimitError(
          `Projected session spend ($${(this.sessionSpendUsd + costUsd).toFixed(6)}) would exceed maxSessionCost limit ($${this.maxSessionCost.toFixed(6)})`,
          "session",
          this.sessionSpendUsd + costUsd,
          this.maxSessionCost
        );
      }

      // Step 5: Resolve relayer address for agent's shard
      const relayerAddrStr = await this.resolveRelayerAddress();
      const nonce = await this.getAccountNonce();
      const chainID = chainIDFromNetwork(requirement.network || this.network);

      // Step 6: Construct and sign Relayed V3 Transaction
      const tx = new Transaction({
        nonce: BigInt(nonce),
        value: 0n,
        sender: this.userAddress,
        receiver: Address.newFromBech32(requirement.payTo),
        gasPrice: 1000000000n,
        gasLimit: 500000n,
        data: Buffer.from(buildEsdtTransferData(requirement.asset, requirement.amount)),
        chainID,
        version: 2,
        options: 0,
        relayer: Address.newFromBech32(relayerAddrStr),
      });

      const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
      const signatureBuffer = await this.signer.sign(bytesToSign);
      const signatureHex = signatureBuffer.toString("hex");

      const paymentPayload: X402PaymentPayload = {
        x402Version: 2,
        resource: {
          url,
          description: "AI Model Inference Payment",
        },
        accepted: requirement,
        payload: {
          nonce,
          value: "0",
          receiver: requirement.payTo,
          sender: this.userAddress.toBech32(),
          gasPrice: 1000000000,
          gasLimit: 500000,
          data: buildEsdtTransferData(requirement.asset, requirement.amount),
          chainID,
          version: 2,
          options: 0,
          signature: signatureHex,
          relayer: relayerAddrStr,
        },
      };

      // Step 7: Base64 encode into PAYMENT-SIGNATURE header
      const encodedPaymentHeader = encodeHeaderJson(paymentPayload);
      const retryHeaders: Record<string, string> = {
        ...initialHeaders,
        "PAYMENT-SIGNATURE": encodedPaymentHeader,
      };

      // Step 8: Retry request with signed payment
      res = await this.customFetch(url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.status === 200 || res.ok) {
        const responseData = (await res.json()) as T;
        const receipt = this.extractReceipt(res, responseData);

        // Record spend
        this.sessionSpendUsd += costUsd;

        return {
          ...responseData,
          ...(receipt ? { paymentReceipt: receipt } : {}),
        };
      }

      // Retry failed with non-200
      let errorBody: unknown;
      try {
        errorBody = await res.json();
      } catch {
        try {
          errorBody = await res.text();
        } catch {
          errorBody = undefined;
        }
      }

      const errMsg =
        typeof errorBody === "object" && errorBody !== null && "error" in errorBody
          ? String((errorBody as { error: unknown }).error)
          : `Payment rejected or settlement failed with HTTP ${res.status}`;

      throw new PaymentError(errMsg, {
        code:
          typeof errorBody === "object" && errorBody !== null && "code" in errorBody
            ? String((errorBody as { code: unknown }).code)
            : undefined,
        details: errorBody,
      });
    }

    // Non-200, Non-402 Error
    let errorDetails: unknown;
    try {
      errorDetails = await res.json();
    } catch {
      try {
        errorDetails = await res.text();
      } catch {
        errorDetails = undefined;
      }
    }

    const msg =
      typeof errorDetails === "object" && errorDetails !== null && "error" in errorDetails
        ? String((errorDetails as { error: unknown }).error)
        : `Request failed with HTTP status ${res.status}`;

    throw new APIError(msg, res.status, errorDetails);
  }

  /**
   * Extracts payment receipt transaction hash from HTTP response headers or response body.
   */
  private extractReceipt(
    res: Response | { headers?: Headers | Record<string, string | string[] | undefined> | { get?(name: string): string | null | undefined } | unknown },
    body?: unknown
  ): string | undefined {
    const headers = (res as { headers?: unknown }).headers;

    let receiptHeader: string | undefined;
    if (headers && typeof (headers as { get?: (name: string) => string | null | undefined }).get === "function") {
      const getFn = (headers as { get: (name: string) => string | null | undefined }).get.bind(headers);
      receiptHeader = getFn("x-payment-receipt") ?? getFn("X-Payment-Receipt") ?? undefined;
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, string | string[] | undefined>;
      const val = record["x-payment-receipt"] ?? record["X-Payment-Receipt"];
      receiptHeader = Array.isArray(val) ? val[0] : val;
    }

    if (receiptHeader && typeof receiptHeader === "string") {
      return receiptHeader;
    }

    let paymentResponseHeader: string | undefined;
    if (headers && typeof (headers as { get?: (name: string) => string | null | undefined }).get === "function") {
      const getFn = (headers as { get: (name: string) => string | null | undefined }).get.bind(headers);
      paymentResponseHeader = getFn("payment-response") ?? getFn("PAYMENT-RESPONSE") ?? undefined;
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, string | string[] | undefined>;
      const val = record["payment-response"] ?? record["PAYMENT-RESPONSE"];
      paymentResponseHeader = Array.isArray(val) ? val[0] : val;
    }

    if (paymentResponseHeader && typeof paymentResponseHeader === "string") {
      try {
        const decoded = decodeHeaderJson<Record<string, unknown>>(paymentResponseHeader);
        if (decoded && typeof decoded.transaction === "string") {
          return decoded.transaction;
        }
      } catch {
        // Ignore decode failure
      }
    }

    if (
      body &&
      typeof body === "object" &&
      "paymentReceipt" in body &&
      typeof (body as Record<string, unknown>).paymentReceipt === "string"
    ) {
      return (body as Record<string, unknown>).paymentReceipt as string;
    }

    return undefined;
  }

  /**
   * Extracts PaymentRequirements from 402 response headers or response JSON body.
   */
  private async extractPaymentRequirements(
    res: Response | { headers?: Headers | Record<string, string | string[] | undefined> | { get?(name: string): string | null | undefined } | unknown; json?: () => Promise<unknown> }
  ): Promise<PaymentRequirements | undefined> {
    const headers = (res as { headers?: unknown }).headers;

    let reqHeader: string | undefined;
    if (headers && typeof (headers as { get?: (name: string) => string | null | undefined }).get === "function") {
      const getFn = (headers as { get: (name: string) => string | null | undefined }).get.bind(headers);
      reqHeader = getFn("payment-required") ?? getFn("PAYMENT-REQUIRED") ?? undefined;
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, string | string[] | undefined>;
      const val = record["payment-required"] ?? record["PAYMENT-REQUIRED"];
      reqHeader = Array.isArray(val) ? val[0] : val;
    }

    if (reqHeader && typeof reqHeader === "string") {
      try {
        const decoded = decodeHeaderJson<Record<string, unknown>>(reqHeader);
        if (decoded?.accepts && Array.isArray(decoded.accepts) && decoded.accepts.length > 0) {
          return decoded.accepts[0] as PaymentRequirements;
        }
        if (decoded?.scheme && decoded?.amount) {
          return decoded as unknown as PaymentRequirements;
        }
      } catch {
        // Fall through to body parsing
      }
    }

    let xReqHeader: string | undefined;
    if (headers && typeof (headers as { get?: (name: string) => string | null | undefined }).get === "function") {
      const getFn = (headers as { get: (name: string) => string | null | undefined }).get.bind(headers);
      xReqHeader = getFn("x-payment-required") ?? getFn("X-Payment-Required") ?? undefined;
    } else if (headers && typeof headers === "object") {
      const record = headers as Record<string, string | string[] | undefined>;
      const val = record["x-payment-required"] ?? record["X-Payment-Required"];
      xReqHeader = Array.isArray(val) ? val[0] : val;
    }

    if (xReqHeader && typeof xReqHeader === "string") {
      try {
        const decoded = decodeHeaderJson<Record<string, unknown>>(xReqHeader);
        if (decoded?.scheme && decoded?.amount) {
          return decoded as unknown as PaymentRequirements;
        }
      } catch {
        // Fall through
      }
    }

    if (typeof (res as { json?: () => Promise<unknown> }).json === "function") {
      try {
        const body = (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
        if (body?.accepts && Array.isArray(body.accepts) && body.accepts.length > 0) {
          return body.accepts[0] as PaymentRequirements;
        }
        if (body?.paymentRequirements) {
          return body.paymentRequirements as PaymentRequirements;
        }
      } catch {
        // Body not JSON
      }
    }

    return undefined;
  }

  /**
   * OpenAI-compatible chat completions endpoint with autonomous x402 payment.
   */
  public async chat(
    model: string,
    messages: string | ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatCompletionResponse & { paymentReceipt?: string }> {
    const formattedMessages: ChatMessage[] =
      typeof messages === "string" ? [{ role: "user", content: messages }] : messages;

    const reqBody = {
      model,
      messages: formattedMessages,
      max_tokens: options?.max_tokens ?? options?.maxTokens ?? 1000,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options ?? {}),
    };

    return this.executeWith402Payment<ChatCompletionResponse>(
      "/api/v1/chat/completions",
      reqBody,
      options?.headers
    );
  }

  /**
   * Anthropic-compatible messages endpoint with autonomous x402 payment.
   */
  public async messages(
    model: string,
    messages: AnthropicMessage[],
    options?: AnthropicOptions
  ): Promise<AnthropicResponse & { paymentReceipt?: string }> {
    const reqBody = {
      model,
      messages,
      max_tokens: options?.max_tokens ?? options?.maxTokens ?? 1000,
      ...(options?.system ? { system: options.system } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options ?? {}),
    };

    return this.executeWith402Payment<AnthropicResponse>(
      "/api/v1/messages",
      reqBody,
      options?.headers
    );
  }

  /**
   * Intelligent Smart Chat routing based on prompt complexity and cost optimization.
   */
  public async smartChat(
    messages: string | ChatMessage[],
    profile: "auto" | "eco" | "premium" = "auto",
    options?: ChatOptions
  ): Promise<SmartChatResponse> {
    const formattedMessages: ChatMessage[] =
      typeof messages === "string" ? [{ role: "user", content: messages }] : messages;

    const fullPromptText = formattedMessages.map((m) => m.content).join("\n");
    const promptLength = fullPromptText.length;

    let targetModel = "openai/gpt-5.4";
    let tier: "eco" | "premium" = "premium";
    let savings = "0%";

    if (profile === "eco") {
      targetModel = "deepseek/deepseek-chat";
      tier = "eco";
      savings = "~94% vs GPT-5.4";
    } else if (profile === "premium") {
      targetModel = "openai/gpt-5.4";
      tier = "premium";
      savings = "0%";
    } else {
      // Auto Profile: Intelligent routing based on complexity heuristics
      const complexKeywords = [
        "proof",
        "prove",
        "debug",
        "architect",
        "smart contract",
        "relayed v3",
        "rust",
        "concurrency",
        "security audit",
        "theorem",
        "optimize",
      ];
      const hasCode = /```|function\s|def\s|class\s|impl\s|pub fn\s/.test(fullPromptText);
      const hasComplexKeywords = complexKeywords.some((kw) =>
        fullPromptText.toLowerCase().includes(kw)
      );

      if (promptLength > 300 || hasCode || hasComplexKeywords) {
        targetModel = "openai/gpt-5.4";
        tier = "premium";
        savings = "0%";
      } else {
        targetModel = "deepseek/deepseek-chat";
        tier = "eco";
        savings = "~94% vs GPT-5.4";
      }
    }

    const response = await this.chat(targetModel, formattedMessages, options);

    return {
      ...response,
      routing: {
        tier,
        savings,
        model: targetModel,
      },
    };
  }
}

/**
 * Convenience factory to setup an autonomous MultiversX agent wallet.
 */
export function setupAgentWallet(options?: {
  pemPath?: string;
  mnemonic?: string;
  network?: string;
  gatewayUrl?: string;
  maxCostPerCall?: number;
  maxSessionCost?: number;
}): BlockRunMvxClient {
  return new BlockRunMvxClient(options);
}
