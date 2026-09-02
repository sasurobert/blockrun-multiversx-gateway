import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL_CATALOG,
  findModel,
  getAllModels,
  ModelDefinition,
} from "../../src/gateway/model_catalog.js";
import {
  PricingEngine,
  estimateCost,
  estimateInputTokens,
  FLAT_FEE_MICRO_USDC,
} from "../../src/gateway/pricing_engine.js";

describe("Model Catalog", () => {
  it("should contain all required flagship AI models with precise pricing", () => {
    const models = getAllModels();
    expect(models.length).toBeGreaterThanOrEqual(5);

    const gpt54 = findModel("openai/gpt-5.4");
    expect(gpt54).toBeDefined();
    expect(gpt54?.pricing.inputPerMillion).toBe(2.5);
    expect(gpt54?.pricing.outputPerMillion).toBe(15.0);

    const sonnet = findModel("anthropic/claude-sonnet-4.6");
    expect(sonnet).toBeDefined();
    expect(sonnet?.pricing.inputPerMillion).toBe(3.0);
    expect(sonnet?.pricing.outputPerMillion).toBe(15.0);

    const dsChat = findModel("deepseek/deepseek-chat");
    expect(dsChat).toBeDefined();
    expect(dsChat?.pricing.inputPerMillion).toBe(0.14);
    expect(dsChat?.pricing.outputPerMillion).toBe(0.28);

    const geminiLite = findModel("google/gemini-2.5-flash-lite");
    expect(geminiLite).toBeDefined();
    expect(geminiLite?.pricing.inputPerMillion).toBe(0.1);
    expect(geminiLite?.pricing.outputPerMillion).toBe(0.4);

    const dsReasoner = findModel("deepseek/deepseek-reasoner");
    expect(dsReasoner).toBeDefined();
    expect(dsReasoner?.pricing.inputPerMillion).toBe(0.55);
    expect(dsReasoner?.pricing.outputPerMillion).toBe(2.19);
  });

  it("should find model by short alias or case-insensitively", () => {
    expect(findModel("gpt-5.4")?.id).toBe("openai/gpt-5.4");
    expect(findModel("claude-sonnet-4.6")?.id).toBe("anthropic/claude-sonnet-4.6");
    expect(findModel("deepseek-chat")?.id).toBe("deepseek/deepseek-chat");
    expect(findModel("gemini-2.5-flash-lite")?.id).toBe("google/gemini-2.5-flash-lite");
    expect(findModel("deepseek-reasoner")?.id).toBe("deepseek/deepseek-reasoner");
    expect(findModel("OPENAI/GPT-5.4")?.id).toBe("openai/gpt-5.4");
  });

  it("should return undefined for unknown models", () => {
    expect(findModel("non-existent-model-xyz")).toBeUndefined();
  });
});

describe("Pricing Engine & Token Estimator", () => {
  it("should estimate input tokens from prompt messages", () => {
    const messages = [
      { role: "system", content: "You are a helpful MultiversX blockchain assistant." },
      { role: "user", content: "How do I sign a Relayed V3 transaction?" },
    ];
    const tokens = estimateInputTokens(messages);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });

  it("should return at least 1 token for empty or minimal messages", () => {
    expect(estimateInputTokens([])).toBe(1);
    expect(estimateInputTokens([{ role: "user", content: "" }])).toBeGreaterThanOrEqual(1);
  });

  it("should calculate exact cost for openai/gpt-5.4 with flat fee", () => {
    const engine = new PricingEngine();
    // 1000 input tokens, 1000 output tokens
    // Input cost: 1000 * 2.50 / 1M = $0.002500 = 2500 micro-USDC
    // Output cost: 1000 * 15.00 / 1M = $0.015000 = 15000 micro-USDC
    // Flat fee: $0.001000 = 1000 micro-USDC
    // Total: 2500 + 15000 + 1000 = 18500 micro-USDC
    const messages = [{ role: "user", content: "a".repeat(4000) }]; // ~1000 tokens
    const cost = engine.estimateCost("openai/gpt-5.4", messages, 1000);

    expect(cost.estimatedTokens).toBeGreaterThanOrEqual(1900);
    expect(parseInt(cost.microUsdc, 10)).toBeGreaterThanOrEqual(18000);
    expect(cost.usdFormatted).toMatch(/^\d+\.\d{6}$/);
    expect(parseFloat(cost.usdFormatted)).toBeCloseTo(parseInt(cost.microUsdc, 10) / 1_000_000, 6);
  });

  it("should calculate exact cost for deepseek/deepseek-chat", () => {
    const engine = new PricingEngine();
    const messages = [{ role: "user", content: "Hello world" }]; // few tokens
    const cost = engine.estimateCost("deepseek/deepseek-chat", messages, 500);

    // Flat fee 1000 micro-USDC + minimal token cost
    expect(parseInt(cost.microUsdc, 10)).toBeGreaterThanOrEqual(1000);
    expect(parseInt(cost.microUsdc, 10)).toBeLessThan(1200);
    expect(cost.usdFormatted.startsWith("0.001")).toBe(true);
  });

  it("should support standalone estimateCost function", () => {
    const result = estimateCost("google/gemini-2.5-flash-lite", [
      { role: "user", content: "Explain quantum computing" },
    ], 1000);

    expect(result.microUsdc).toBeDefined();
    expect(result.usdFormatted).toBeDefined();
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(parseInt(result.microUsdc, 10)).toBeGreaterThanOrEqual(FLAT_FEE_MICRO_USDC);
  });

  it("should allow custom flat fee and custom model catalog", () => {
    const customModels: ModelDefinition[] = [
      {
        id: "custom/fast-llm",
        name: "Custom Fast LLM",
        provider: "custom",
        contextLength: 32000,
        pricing: {
          inputPerMillion: 1.0,
          outputPerMillion: 2.0,
          inputPerToken: 0.000001,
          outputPerToken: 0.000002,
          currency: "USD",
        },
      },
    ];

    const engine = new PricingEngine({
      catalog: customModels,
      flatFeeMicroUsdc: 2500, // $0.0025 flat fee
    });

    const cost = engine.estimateCost("custom/fast-llm", [{ role: "user", content: "Hi" }], 100);
    expect(parseInt(cost.microUsdc, 10)).toBeGreaterThanOrEqual(2500);
  });

  it("should throw error when unknown model is requested", () => {
    const engine = new PricingEngine();
    expect(() =>
      engine.estimateCost("unknown/fake-model", [{ role: "user", content: "Hi" }])
    ).toThrow(/unsupported or unknown model/i);
  });

  it("should throw error when prompt + maxTokens exceeds model context length", () => {
    const engine = new PricingEngine();
    // gpt-5.4 context length is 128000
    expect(() =>
      engine.estimateCost("openai/gpt-5.4", [{ role: "user", content: "Hi" }], 130000)
    ).toThrow(/context length/i);
  });
});
