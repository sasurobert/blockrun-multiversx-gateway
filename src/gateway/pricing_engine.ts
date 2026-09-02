import {
  DEFAULT_MODEL_CATALOG,
  findModel,
  ModelDefinition,
} from "./model_catalog.js";

/**
 * Standard flat transaction fee: $0.001 = 1,000 micro-USDC (USDC decimals: 6).
 */
export const FLAT_FEE_MICRO_USDC = 1000;

/**
 * Configuration options for the Pricing Engine.
 */
export interface PricingEngineOptions {
  catalog?: ModelDefinition[];
  flatFeeMicroUsdc?: number;
  defaultMaxTokens?: number;
}

/**
 * Estimated cost breakdown result.
 */
export interface CostEstimateResult {
  microUsdc: string;
  usdFormatted: string;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Estimates token count from chat messages.
 * Uses BPE-aware heuristic (~4 characters per ASCII token, ~1.5 characters per non-ASCII/CJK token, plus per-message role overhead).
 */
export function estimateInputTokens(
  messages: Array<{ role?: string; content?: string }>
): number {
  if (!messages || messages.length === 0) {
    return 1;
  }

  let totalTokens = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    const roleLen = typeof msg.role === "string" ? msg.role.length : 0;

    // Per-message role + formatting overhead: ~4 tokens
    totalTokens += Math.max(4, Math.ceil(roleLen / 4) + 4);

    if (content.length > 0) {
      let asciiChars = 0;
      let nonAsciiChars = 0;
      for (let i = 0; i < content.length; i++) {
        const code = content.charCodeAt(i);
        if (code <= 127) {
          asciiChars++;
        } else {
          nonAsciiChars++;
        }
      }
      const contentTokens = Math.ceil(asciiChars / 4) + Math.ceil(nonAsciiChars / 1.5);
      totalTokens += Math.max(1, contentTokens);
    }
  }

  return Math.max(1, totalTokens);
}

/**
 * Pricing Engine class for calculating AI compute pricing and MultiversX x402 payment requirements.
 */
export class PricingEngine {
  private catalog: ModelDefinition[];
  private flatFeeMicroUsdc: number;
  private defaultMaxTokens: number;

  constructor(options?: PricingEngineOptions) {
    this.catalog = options?.catalog ?? DEFAULT_MODEL_CATALOG;
    this.flatFeeMicroUsdc = options?.flatFeeMicroUsdc ?? FLAT_FEE_MICRO_USDC;
    this.defaultMaxTokens = options?.defaultMaxTokens ?? 1000;
  }

  /**
   * Estimates cost for a given model, prompt messages, and expected output tokens.
   */
  public estimateCost(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens?: number
  ): CostEstimateResult {
    const model = findModel(modelId, this.catalog);
    if (!model) {
      throw new Error(`Unsupported or unknown model: ${modelId}`);
    }

    const inputTokens = estimateInputTokens(messages);
    const outputTokens =
      maxTokens !== undefined && maxTokens > 0 ? maxTokens : this.defaultMaxTokens;

    const totalTokens = inputTokens + outputTokens;
    if (model.contextLength && totalTokens > model.contextLength) {
      throw new Error(
        `Requested tokens (${totalTokens} = ${inputTokens} input + ${outputTokens} output) exceed model context length (${model.contextLength}) for '${model.id}'`
      );
    }

    // inputPricePerMillion is in USD per 1,000,000 tokens.
    // 1 USD = 1,000,000 micro-USDC.
    // Therefore, tokens * (USD / 1,000,000) * 1,000,000 = tokens * USD_per_million.
    const inputCostMicroUsdc = inputTokens * model.pricing.inputPerMillion;
    const outputCostMicroUsdc = outputTokens * model.pricing.outputPerMillion;

    const totalMicroUsdc = Math.ceil(
      inputCostMicroUsdc + outputCostMicroUsdc + this.flatFeeMicroUsdc
    );

    const microUsdcStr = totalMicroUsdc.toString();
    const usdFormatted = (totalMicroUsdc / 1_000_000).toFixed(6);
    const estimatedTokens = inputTokens + outputTokens;

    return {
      microUsdc: microUsdcStr,
      usdFormatted,
      estimatedTokens,
      inputTokens,
      outputTokens,
    };
  }

  /**
   * Returns registered models.
   */
  public getModels(): ModelDefinition[] {
    return this.catalog;
  }
}

/**
 * Standalone helper function to estimate AI execution cost in micro-USDC and USD.
 */
export function estimateCost(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  options?: PricingEngineOptions
): { microUsdc: string; usdFormatted: string; estimatedTokens: number } {
  const engine = new PricingEngine(options);
  const result = engine.estimateCost(model, messages, maxTokens);
  return {
    microUsdc: result.microUsdc,
    usdFormatted: result.usdFormatted,
    estimatedTokens: result.estimatedTokens,
  };
}
