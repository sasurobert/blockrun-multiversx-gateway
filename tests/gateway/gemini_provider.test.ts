import { describe, it, expect, vi } from "vitest";
import { GeminiProvider } from "../../src/gateway/gemini_provider.js";

describe("GeminiProvider", () => {
  it("should report availability based on API key", () => {
    const emptyProvider = new GeminiProvider("");
    expect(emptyProvider.isAvailable()).toBe(false);

    const activeProvider = new GeminiProvider("valid-fake-key");
    expect(activeProvider.isAvailable()).toBe(true);
  });

  it("should throw error if called without API key", async () => {
    const provider = new GeminiProvider("");
    await expect(
      provider.generateCompletion([{ role: "user", content: "hello" }])
    ).rejects.toThrow("Gemini API key is not configured");
  });

  it("should correctly format system instruction and user messages", async () => {
    const provider = new GeminiProvider("mock-key");
    const formatMethod = (provider as any).formatPayload.bind(provider);

    const payload = formatMethod([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Explain sharding." },
      { role: "assistant", content: "Sharding partitions the network." },
      { role: "user", content: "Tell me more." },
    ]);

    expect(payload.systemInstruction).toBeDefined();
    expect(payload.systemInstruction.parts[0].text).toBe("You are a helpful assistant.");
    expect(payload.contents).toHaveLength(3);
    expect(payload.contents[0].role).toBe("user");
    expect(payload.contents[1].role).toBe("model");
    expect(payload.contents[2].role).toBe("user");
  });

  it("should generate completion using mock fetch", async () => {
    const provider = new GeminiProvider("mock-key");
    const originalFetch = global.fetch;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "MultiversX Sirius has 0.6s block time." }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 10,
          totalTokenCount: 25,
        },
      }),
    });

    try {
      const res = await provider.generateCompletion([
        { role: "user", content: "What is Sirius block time?" },
      ]);

      expect(res.text).toBe("MultiversX Sirius has 0.6s block time.");
      expect(res.inputTokens).toBe(15);
      expect(res.outputTokens).toBe(10);
      expect(res.totalTokens).toBe(25);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
