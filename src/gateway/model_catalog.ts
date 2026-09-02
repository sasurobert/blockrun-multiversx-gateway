/**
 * Model Pricing details.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  inputPerToken: number;
  outputPerToken: number;
  currency: string;
}

/**
 * AI Model Definition supported by BlockRun AI Gateway.
 */
export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  pricing: ModelPricing;
  description?: string;
  aliases?: string[];
}

/**
 * Standard default AI model catalog for BlockRun MultiversX Gateway.
 * Prices conform to official pricing schedules per 1M tokens.
 */
export const DEFAULT_MODEL_CATALOG: ModelDefinition[] = [
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    contextLength: 128000,
    pricing: {
      inputPerMillion: 2.50,
      outputPerMillion: 15.00,
      inputPerToken: 0.0000025,
      outputPerToken: 0.000015,
      currency: "USD",
    },
    description: "OpenAI flagship high-intelligence reasoning and coding model",
    aliases: ["gpt-5.4", "gpt-5", "openai/gpt-5"],
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextLength: 200000,
    pricing: {
      inputPerMillion: 3.00,
      outputPerMillion: 15.00,
      inputPerToken: 0.000003,
      outputPerToken: 0.000015,
      currency: "USD",
    },
    description: "Anthropic balanced high-performance enterprise model",
    aliases: ["claude-sonnet-4.6", "claude-sonnet", "claude-4.6-sonnet", "anthropic/claude-sonnet"],
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    contextLength: 128000,
    pricing: {
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      inputPerToken: 0.00000014,
      outputPerToken: 0.00000028,
      currency: "USD",
    },
    description: "DeepSeek V3 highly cost-effective general language model",
    aliases: ["deepseek-chat", "deepseek-v3", "deepseek/deepseek-v3"],
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    provider: "google",
    contextLength: 1000000,
    pricing: {
      inputPerMillion: 0.10,
      outputPerMillion: 0.40,
      inputPerToken: 0.0000001,
      outputPerToken: 0.0000004,
      currency: "USD",
    },
    description: "Google ultra-fast lightweight multimodal model with 1M context",
    aliases: ["gemini-2.5-flash-lite", "gemini-flash-lite", "google/gemini-flash-lite"],
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    contextLength: 128000,
    pricing: {
      inputPerMillion: 0.55,
      outputPerMillion: 2.19,
      inputPerToken: 0.00000055,
      outputPerToken: 0.00000219,
      currency: "USD",
    },
    description: "DeepSeek R1 advanced reasoning and chain-of-thought model",
    aliases: ["deepseek-reasoner", "deepseek-r1", "deepseek/deepseek-r1"],
  },
];

/**
 * Finds a model in the catalog by exact ID, lowercase ID, or registered alias.
 */
export function findModel(
  modelId: string,
  catalog: ModelDefinition[] = DEFAULT_MODEL_CATALOG
): ModelDefinition | undefined {
  if (!modelId || typeof modelId !== "string") {
    return undefined;
  }

  const normalized = modelId.trim().toLowerCase();

  for (const model of catalog) {
    if (model.id.toLowerCase() === normalized) {
      return model;
    }
    if (model.aliases?.some((alias) => alias.toLowerCase() === normalized)) {
      return model;
    }
  }

  return undefined;
}

/**
 * Returns all available models in the catalog.
 */
export function getAllModels(
  catalog: ModelDefinition[] = DEFAULT_MODEL_CATALOG
): ModelDefinition[] {
  return [...catalog];
}
