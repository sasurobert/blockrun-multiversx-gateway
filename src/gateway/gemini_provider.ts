import { Readable } from "stream";

export interface GeminiMessage {
  role: string;
  content: string;
}

export interface GeminiCompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GeminiCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
}

export class GeminiProvider {
  private apiKey: string;
  private defaultModel: string;
  private timeoutMs: number;

  constructor(apiKey?: string, options?: { defaultModel?: string; timeoutMs?: number }) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || "";
    this.defaultModel = options?.defaultModel || "gemini-2.5-flash-lite";
    this.timeoutMs = options?.timeoutMs || 30000;
  }

  public isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Translates OpenAI / Anthropic format messages to Gemini format.
   */
  private formatPayload(messages: GeminiMessage[], options?: GeminiCompletionOptions) {
    let systemText = "";
    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemText += (systemText ? "\n" : "") + (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else {
        const role = msg.role === "assistant" ? "model" : "user";
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        contents.push({
          role,
          parts: [{ text }],
        });
      }
    }

    // Ensure at least one user message
    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    const payload: Record<string, unknown> = {
      contents,
    };

    if (systemText) {
      payload.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (options?.maxTokens) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    return payload;
  }

  /**
   * Generates completion via Gemini REST API.
   */
  public async generateCompletion(
    messages: GeminiMessage[],
    options?: GeminiCompletionOptions
  ): Promise<GeminiCompletionResult> {
    if (!this.isAvailable()) {
      throw new Error("Gemini API key is not configured");
    }

    const modelName = options?.model?.replace(/^google\//, "") || this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${this.apiKey}`;

    const body = JSON.stringify(this.formatPayload(messages, options));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errText}`);
      }

      const data = (await response.json()) as any;
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || "";
      const usage = data.usageMetadata || {};

      return {
        text,
        inputTokens: usage.promptTokenCount || Math.ceil(body.length / 4),
        outputTokens: usage.candidatesTokenCount || Math.ceil(text.length / 4),
        totalTokens: usage.totalTokenCount || (Math.ceil(body.length / 4) + Math.ceil(text.length / 4)),
        model: modelName,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Streams completion tokens via Gemini REST SSE.
   */
  public async *streamCompletion(
    messages: GeminiMessage[],
    options?: GeminiCompletionOptions
  ): AsyncGenerator<{ text: string; done: boolean }, void, unknown> {
    if (!this.isAvailable()) {
      throw new Error("Gemini API key is not configured");
    }

    const modelName = options?.model?.replace(/^google\//, "") || this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?key=${this.apiKey}&alt=sse`;

    const body = JSON.stringify(this.formatPayload(messages, options));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text();
        throw new Error(`Gemini Stream error (${response.status}): ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          yield { text: "", done: true };
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === "[DONE]") {
              yield { text: "", done: true };
              return;
            }
            try {
              const parsed = JSON.parse(jsonStr);
              const partText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (partText) {
                yield { text: partText, done: false };
              }
            } catch {
              // Partial line or heartbeat, continue
            }
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
