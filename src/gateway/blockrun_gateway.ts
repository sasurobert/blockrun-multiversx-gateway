import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import {
  MvxAddressSchema,
} from "../domain/schemas.js";
import {
  PaymentErrorCode,
  PaymentRequirements,
} from "../domain/types.js";
import { IVerifierService } from "../services/verifier.js";
import { ISettlerService } from "../services/settler.js";
import { ISettlementQueue } from "../services/settlement_queue.js";
import { RelayerPoolManager } from "../services/relayer_pool.js";
import {
  buildPaymentResponseHeaders,
  encodeHeaderJson,
  extractPaymentPayload,
} from "../utils/header_utils.js";
import {
  DEFAULT_MODEL_CATALOG,
  findModel,
  getAllModels,
  ModelDefinition,
} from "./model_catalog.js";
import {
  CostEstimateResult,
  FLAT_FEE_MICRO_USDC,
  PricingEngine,
} from "./pricing_engine.js";

import { RateLimitConfig } from "../server/facilitator_server.js";
import {
  defaultMetricsRegistry,
  httpRequestsTotal,
  paymentsSettledTotal,
  spendMicroUsdcTotal,
} from "../server/metrics.js";

import { GeminiProvider } from "./gemini_provider.js";
import { FleetService } from "../services/fleet_service.js";

export type UpstreamAiHandler = (
  reqBody: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

/**
 * Options for configuring the BlockRun AI Gateway Proxy.
 */
export interface BlockRunGatewayOptions {
  verifier: IVerifierService;
  settler?: ISettlerService;
  settlementQueue?: ISettlementQueue;
  relayerPool?: RelayerPoolManager;
  fleetService?: FleetService;
  geminiApiKey?: string;
  payTo: string;
  network?: string;
  asset?: string;
  assetName?: string;
  assetDecimals?: number;
  maxTimeoutSeconds?: number;
  flatFeeMicroUsdc?: number;
  models?: ModelDefinition[];
  upstreamAiHandler?: UpstreamAiHandler;
  upstreamTimeoutMs?: number;
  corsOrigins?: string | string[] | boolean;
  rateLimit?: RateLimitConfig;
  trustProxy?: boolean | string | number;
  name?: string;
  version?: string;
}

/**
 * Simple, efficient in-memory rate limiting middleware with timer pruning.
 */
function createRateLimiter(config?: RateLimitConfig) {
  if (config?.enabled === false) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const windowMs = config?.windowMs ?? 60 * 1000;
  const maxRequests = config?.max ?? 120;
  const clientRequests = new Map<string, { count: number; resetTime: number }>();

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of clientRequests.entries()) {
      if (now > record.resetTime) {
        clientRequests.delete(ip);
      }
    }
  }, windowMs);
  if (interval.unref) {
    interval.unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "anonymous";
    const now = Date.now();

    const record = clientRequests.get(ip);
    if (!record || now > record.resetTime) {
      clientRequests.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    record.count++;
    res.setHeader("X-RateLimit-Limit", maxRequests.toString());
    res.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, maxRequests - record.count).toString()
    );
    res.setHeader("X-RateLimit-Reset", Math.ceil(record.resetTime / 1000).toString());

    if (record.count > maxRequests) {
      res.status(429).json({
        error: "Too many requests, please try again later",
        retryAfterMs: Math.max(0, record.resetTime - now),
      });
      return;
    }

    next();
  };
}

/**
 * Generates OpenAI compatible mock completion response.
 */
function generateMockOpenAIResponse(
  model: ModelDefinition,
  messages: Array<{ role?: string; content?: string }>,
  cost: CostEstimateResult
) {
  const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const excerpt = typeof userMsg === "string" ? userMsg.slice(0, 50) : "query";
  return {
    id: `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `Hello! I am ${model.name}. Response to: "${excerpt}". MultiversX x402 payment settled.`,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: cost.inputTokens,
      completion_tokens: cost.outputTokens,
      total_tokens: cost.estimatedTokens,
    },
  };
}

/**
 * Generates Anthropic compatible mock messages response.
 */
function generateMockAnthropicResponse(
  model: ModelDefinition,
  messages: Array<{ role?: string; content?: string }>,
  cost: CostEstimateResult
) {
  const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const excerpt = typeof userMsg === "string" ? userMsg.slice(0, 50) : "query";
  return {
    id: `msg_${Math.random().toString(36).substring(2, 14)}`,
    type: "message",
    role: "assistant",
    model: model.id,
    content: [
      {
        type: "text",
        text: `Hello! I am ${model.name}. Processed prompt: "${excerpt}". MultiversX x402 payment settled.`,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: cost.inputTokens,
      output_tokens: cost.outputTokens,
    },
  };
}

/**
 * Executes an upstream AI call with timeout and AbortSignal support.
 */
async function executeWithTimeout<T>(
  fnOrPromise: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs?: number,
  clientSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();

  if (clientSignal) {
    if (clientSignal.aborted) {
      controller.abort();
    } else {
      clientSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    if (timer.unref) {
      timer.unref();
    }
  }

  try {
    const promise =
      typeof fnOrPromise === "function" ? fnOrPromise(controller.signal) : fnOrPromise;

    if (!timeoutMs || timeoutMs <= 0) {
      return await promise;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        const err = new Error(`Upstream AI request timed out after ${timeoutMs}ms`);
        (err as unknown as Record<string, unknown>).statusCode = 504;
        reject(err);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          const err = new Error(`Upstream AI request timed out after ${timeoutMs}ms`);
          (err as unknown as Record<string, unknown>).statusCode = 504;
          reject(err);
        },
        { once: true }
      );
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Creates and configures an Express application for the BlockRun AI Gateway Proxy.
 */
export function createBlockRunGateway(options: BlockRunGatewayOptions): Express {
  // Validate merchant address
  const parseAddress = MvxAddressSchema.safeParse(options.payTo);
  if (!parseAddress.success) {
    throw new Error(`Invalid merchant payTo address: ${options.payTo}`);
  }

  const app = express();

  if (options.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy);
  }

  const gatewayName = options.name ?? "BlockRun MultiversX AI Gateway";
  const gatewayVersion = options.version ?? "1.0.0";
  const catalog = options.models ?? DEFAULT_MODEL_CATALOG;
  const network = options.network ?? "multiversx:1";
  const asset = options.asset ?? "USDC-c76f1f";
  const assetName = options.assetName ?? "USD Coin";
  const assetDecimals = options.assetDecimals ?? 6;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 300;
  const flatFeeMicroUsdc = options.flatFeeMicroUsdc ?? FLAT_FEE_MICRO_USDC;

  const pricingEngine = new PricingEngine({
    catalog,
    flatFeeMicroUsdc,
  });

  const geminiProvider = new GeminiProvider(options.geminiApiKey || process.env.GEMINI_API_KEY, {
    timeoutMs: options.upstreamTimeoutMs ?? 30000,
  });

  const fleetService = options.fleetService ?? new FleetService({
    geminiApiKey: options.geminiApiKey || process.env.GEMINI_API_KEY,
    merchantAddress: options.payTo,
    tokenId: asset,
  });

  // 1. Helmet security headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  // 2. CORS setup
  app.use(
    cors({
      origin: options.corsOrigins ?? "*",
      exposedHeaders: [
        "PAYMENT-REQUIRED",
        "payment-required",
        "PAYMENT-RESPONSE",
        "payment-response",
        "X-Payment-Required",
        "x-payment-required",
        "X-Payment-Receipt",
        "x-payment-receipt",
        "X-Payment-Settled",
        "x-payment-settled",
        "WWW-Authenticate",
        "www-authenticate",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
      ],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "PAYMENT-SIGNATURE",
        "payment-signature",
        "X-Payment",
        "x-payment",
        "x-payment-signature",
      ],
    })
  );

  // 3. Body parsing
  app.use(express.json({ limit: "1mb" }));

  // 4. Rate Limiter
  app.use(createRateLimiter(options.rateLimit));

  // 5. Telemetry Tracking
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      httpRequestsTotal.inc({
        method: req.method,
        endpoint: req.route?.path || req.path,
        status: res.statusCode.toString(),
      });
    });
    next();
  });

  // --- Endpoints ---

  /**
   * GET /health
   * Gateway health check.
   */
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      name: gatewayName,
      version: gatewayVersion,
      modelsCount: catalog.length,
      payTo: options.payTo,
      queueStats: options.settlementQueue?.getShardStats(),
    });
  });

  /**
   * GET /metrics
   * Prometheus exposition format telemetry.
   */
  app.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(defaultMetricsRegistry.serialize());
  });

  /**
   * GET /api/v1/models
   * Lists available models, context length, and token pricing.
   */
  app.get("/api/v1/models", (_req: Request, res: Response) => {
    res.json({
      object: "list",
      data: catalog.map((m) => ({
        id: m.id,
        object: "model",
        created: 1725280000,
        owned_by: m.provider,
        context_length: m.contextLength,
        pricing: {
          input_per_million: m.pricing.inputPerMillion,
          output_per_million: m.pricing.outputPerMillion,
          input_per_token: m.pricing.inputPerToken,
          output_per_token: m.pricing.outputPerToken,
          currency: m.pricing.currency,
        },
        description: m.description,
        aliases: m.aliases,
      })),
    });
  });

  /**
   * GET /relayer/address/:userAddress
   * Resolves the relayer address and shard ID for a MultiversX user address.
   */
  app.get("/relayer/address/:userAddress", (req: Request, res: Response) => {
    const parseResult = MvxAddressSchema.safeParse(req.params.userAddress);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid MultiversX address format",
        details: parseResult.error.format(),
      });
      return;
    }

    const relayerPool =
      options.relayerPool ??
      (typeof (options.verifier as any)?.getRelayerPool === "function"
        ? (options.verifier as any).getRelayerPool()
        : undefined);

    if (!relayerPool) {
      res.status(503).json({
        error: "Relayer pool is not configured on this gateway",
      });
      return;
    }

    try {
      const userAddress = parseResult.data;
      const shard = relayerPool.getShardForAddress(userAddress);
      const relayerAddress = relayerPool.getRelayerAddressForUser(userAddress);
      res.json({ relayerAddress, shard });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(404).json({
        error: "Failed to resolve relayer for address",
        details: message,
      });
    }
  });

  /**
   * GET /relayer/shards
   * Returns configured relayer addresses and shards.
   */
  app.get("/relayer/shards", (_req: Request, res: Response) => {
    const relayerPool =
      options.relayerPool ??
      (typeof (options.verifier as any)?.getRelayerPool === "function"
        ? (options.verifier as any).getRelayerPool()
        : undefined);

    if (!relayerPool) {
      res.json({ relayers: {}, shards: [] });
      return;
    }

    const relayerMap = relayerPool.getAllRelayerAddresses();
    const shards = Object.keys(relayerMap).map(Number);
    res.json({ relayers: relayerMap, shards });
  });

  /**
   * Helper function to handle settlement execution.
   */
  async function executeSettlement(
    paymentPayload: any,
    paymentRequirements: PaymentRequirements
  ) {
    if (options.settlementQueue) {
      return await options.settlementQueue.enqueue({
        paymentPayload,
        paymentRequirements,
      });
    }
    if (options.settler) {
      return await options.settler.settle({
        paymentPayload,
        paymentRequirements,
      });
    }
    return {
      success: true,
      transaction: `mock-settlement-${Date.now()}`,
      network: paymentRequirements.network,
    };
  }

  /**
   * GET /api/v1/fleet/status
   * Returns current live status, addresses, balances, and last transactions for all autonomous bots.
   */
  app.get("/api/v1/fleet/status", async (_req: Request, res: Response) => {
    try {
      const statuses = await fleetService.getAllStatuses();
      res.json({ bots: statuses, timestamp: new Date().toISOString() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to retrieve fleet status";
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/v1/fleet/run-step
   * Triggers an autonomous inference step for a bot:
   * 1. Signs real Relayed V3 transaction with 0 EGLD.
   * 2. Broadcasts to Devnet with exact gas.
   * 3. Queries Gemini for real AI completion.
   */
  app.post("/api/v1/fleet/run-step", async (req: Request, res: Response) => {
    try {
      const { botId, prompt } = req.body || {};
      if (!botId || typeof botId !== "string") {
        res.status(400).json({ error: "botId (string) is required" });
        return;
      }

      const result = await fleetService.executeBotStep(botId, prompt);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to execute bot step";
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/v1/playground/chat
   * Direct playground endpoint executing real on-chain Devnet Relayed V3 transaction
   * and generating real Gemini completion.
   */
  app.post("/api/v1/playground/chat", async (req: Request, res: Response) => {
    try {
      const { prompt, model: requestedModel } = req.body || {};
      if (!prompt || typeof prompt !== "string") {
        res.status(400).json({ error: "prompt (string) is required" });
        return;
      }

      const result = await fleetService.executeBotStep("bot-shard0", prompt);
      res.json({
        completion: result.completion,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        gasLimit: result.gasLimit,
        gasSponsored: result.gasSponsored,
        agentEgldSpent: result.agentEgldSpent,
        usdcAmount: result.usdcAmount,
        model: requestedModel || "google/gemini-2.5-flash-lite",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process playground chat";
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/v1/chat/completions
   * OpenAI-compatible chat completions with x402 payment verification and settlement.
   */
  app.post("/api/v1/chat/completions", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { model: modelId, messages, max_tokens, maxTokens } = req.body || {};
      if (!modelId || typeof modelId !== "string" || !messages || !Array.isArray(messages)) {
        res.status(400).json({
          error: "Invalid request: 'model' (string) and 'messages' (array) are required",
        });
        return;
      }

      const model = findModel(modelId, catalog);
      if (!model) {
        res.status(400).json({
          error: `Unsupported model: '${modelId}'. Available models: ${catalog.map((m) => m.id).join(", ")}`,
        });
        return;
      }

      const effectiveMaxTokens = max_tokens ?? maxTokens ?? 1000;
      const cost = pricingEngine.estimateCost(model.id, messages, effectiveMaxTokens);

      const paymentRequirements: PaymentRequirements = {
        scheme: "exact",
        network,
        amount: cost.microUsdc,
        asset,
        payTo: options.payTo,
        maxTimeoutSeconds,
        extra: {
          name: assetName,
          decimals: assetDecimals,
        },
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [paymentRequirements],
        error: "Payment Required",
        message: "This endpoint requires x402 payment",
        price: {
          amount: cost.usdFormatted,
          currency: "USD",
        },
        paymentInfo: {
          network: "multiversx",
          asset: "USDC",
          x402Version: 2,
        },
      };

      // Step 1: Check for payment header
      const paymentPayload = extractPaymentPayload(req.headers);
      if (!paymentPayload) {
        res.setHeader("PAYMENT-REQUIRED", encodeHeaderJson(challengeBody));
        res.setHeader("X-Payment-Required", encodeHeaderJson(paymentRequirements));
        res.setHeader(
          "WWW-Authenticate",
          `x402 scheme="exact", network="${paymentRequirements.network}", amount="${paymentRequirements.amount}", asset="${paymentRequirements.asset}", payTo="${paymentRequirements.payTo}"`
        );
        res.status(402).json(challengeBody);
        return;
      }

      // Step 2: Verify payment payload
      const verifyResult = await options.verifier.verify({
        paymentPayload,
        paymentRequirements,
      });

      if (!verifyResult.isValid) {
        const verifyHeaders = buildPaymentResponseHeaders(verifyResult);
        for (const [k, v] of Object.entries(verifyHeaders)) {
          res.setHeader(k, v);
        }
        res.setHeader("X-Payment-Settled", "false");
        res.status(402).json({
          error: "Payment verification failed",
          code: verifyResult.errorCode ?? PaymentErrorCode.PAYMENT_INVALID,
          message: verifyResult.invalidReason ?? "Invalid payment signature or parameters",
        });
        return;
      }

      // Step 3: Settle payment
      const settleResult = await executeSettlement(paymentPayload, paymentRequirements);
      const settleHeaders = buildPaymentResponseHeaders(settleResult);
      for (const [k, v] of Object.entries(settleHeaders)) {
        res.setHeader(k, v);
      }

      const isStreaming = req.body?.stream === true;

      // Step 4: Execute AI model inference
      let aiResponse: Record<string, unknown>;
      if (options.upstreamAiHandler) {
        aiResponse = await executeWithTimeout(
          (signal) => options.upstreamAiHandler!(req.body, signal),
          options.upstreamTimeoutMs
        );
      } else if (geminiProvider.isAvailable()) {
        try {
          const geminiResult = await executeWithTimeout(
            (signal) =>
              geminiProvider.generateCompletion(messages, {
                model: model.id,
                maxTokens: effectiveMaxTokens,
                signal,
              }),
            options.upstreamTimeoutMs
          );
          aiResponse = {
            id: `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: geminiResult.text,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: geminiResult.inputTokens,
              completion_tokens: geminiResult.outputTokens,
              total_tokens: geminiResult.totalTokens,
            },
          };
        } catch {
          aiResponse = generateMockOpenAIResponse(model, messages, cost);
        }
      } else {
        aiResponse = generateMockOpenAIResponse(model, messages, cost);
      }

      if (isStreaming) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.status(200);

        const content =
          (aiResponse?.choices as any[])?.[0]?.message?.content ??
          aiResponse?.content ??
          "MultiversX x402 payment settled.";
        const words = String(content).split(" ");

        for (const word of words) {
          const chunk = {
            id: aiResponse?.id ?? `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                delta: { content: word + " " },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        const stopChunk = {
          id: aiResponse?.id ?? `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.status(200).json(aiResponse);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/messages
   * Anthropic-compatible messages endpoint with x402 payment verification and settlement.
   */
  app.post("/api/v1/messages", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { model: modelId, messages, system, max_tokens, maxTokens } = req.body || {};
      if (!modelId || typeof modelId !== "string" || !messages || !Array.isArray(messages)) {
        res.status(400).json({
          error: "Invalid request: 'model' (string) and 'messages' (array) are required",
        });
        return;
      }

      const model = findModel(modelId, catalog);
      if (!model) {
        res.status(400).json({
          error: `Unsupported model: '${modelId}'. Available models: ${catalog.map((m) => m.id).join(", ")}`,
        });
        return;
      }

      // Normalize Anthropic messages format for token estimation
      const normalizedMessages: Array<{ role: string; content: string }> = [];
      if (system && typeof system === "string") {
        normalizedMessages.push({ role: "system", content: system });
      }
      for (const msg of messages) {
        let contentStr = "";
        if (typeof msg.content === "string") {
          contentStr = msg.content;
        } else if (Array.isArray(msg.content)) {
          contentStr = msg.content
            .map((c: any) => (typeof c === "string" ? c : c.text ?? ""))
            .join("\n");
        }
        normalizedMessages.push({ role: msg.role || "user", content: contentStr });
      }

      const effectiveMaxTokens = max_tokens ?? maxTokens ?? 1000;
      const cost = pricingEngine.estimateCost(model.id, normalizedMessages, effectiveMaxTokens);

      const paymentRequirements: PaymentRequirements = {
        scheme: "exact",
        network,
        amount: cost.microUsdc,
        asset,
        payTo: options.payTo,
        maxTimeoutSeconds,
        extra: {
          name: assetName,
          decimals: assetDecimals,
        },
      };

      const challengeBody = {
        x402Version: 2,
        accepts: [paymentRequirements],
        error: "Payment Required",
        message: "This endpoint requires x402 payment",
        price: {
          amount: cost.usdFormatted,
          currency: "USD",
        },
        paymentInfo: {
          network: "multiversx",
          asset: "USDC",
          x402Version: 2,
        },
      };

      // Step 1: Check for payment header
      const paymentPayload = extractPaymentPayload(req.headers);
      if (!paymentPayload) {
        res.setHeader("PAYMENT-REQUIRED", encodeHeaderJson(challengeBody));
        res.setHeader("X-Payment-Required", encodeHeaderJson(paymentRequirements));
        res.setHeader(
          "WWW-Authenticate",
          `x402 scheme="exact", network="${paymentRequirements.network}", amount="${paymentRequirements.amount}", asset="${paymentRequirements.asset}", payTo="${paymentRequirements.payTo}"`
        );
        res.status(402).json(challengeBody);
        return;
      }

      // Step 2: Verify payment payload
      const verifyResult = await options.verifier.verify({
        paymentPayload,
        paymentRequirements,
      });

      if (!verifyResult.isValid) {
        const verifyHeaders = buildPaymentResponseHeaders(verifyResult);
        for (const [k, v] of Object.entries(verifyHeaders)) {
          res.setHeader(k, v);
        }
        res.setHeader("X-Payment-Settled", "false");
        res.status(402).json({
          error: "Payment verification failed",
          code: verifyResult.errorCode ?? PaymentErrorCode.PAYMENT_INVALID,
          message: verifyResult.invalidReason ?? "Invalid payment signature or parameters",
        });
        return;
      }

      // Step 3: Settle payment
      const settleResult = await executeSettlement(paymentPayload, paymentRequirements);
      const settleHeaders = buildPaymentResponseHeaders(settleResult);
      for (const [k, v] of Object.entries(settleHeaders)) {
        res.setHeader(k, v);
      }

      const isStreaming = req.body?.stream === true;

      // Step 4: Execute AI model inference
      let aiResponse: Record<string, unknown>;
      if (options.upstreamAiHandler) {
        aiResponse = await executeWithTimeout(
          (signal) => options.upstreamAiHandler!(req.body, signal),
          options.upstreamTimeoutMs
        );
      } else if (geminiProvider.isAvailable()) {
        try {
          const geminiResult = await executeWithTimeout(
            (signal) =>
              geminiProvider.generateCompletion(normalizedMessages, {
                model: model.id,
                maxTokens: effectiveMaxTokens,
                signal,
              }),
            options.upstreamTimeoutMs
          );
          aiResponse = {
            id: `msg_${Math.random().toString(36).substring(2, 14)}`,
            type: "message",
            role: "assistant",
            model: model.id,
            content: [
              {
                type: "text",
                text: geminiResult.text,
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: geminiResult.inputTokens,
              output_tokens: geminiResult.outputTokens,
            },
          };
        } catch {
          aiResponse = generateMockAnthropicResponse(model, normalizedMessages, cost);
        }
      } else {
        aiResponse = generateMockAnthropicResponse(model, normalizedMessages, cost);
      }

      if (isStreaming) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.status(200);

        const content =
          (aiResponse?.content as any[])?.[0]?.text ??
          aiResponse?.text ??
          "MultiversX x402 payment settled.";
        const words = String(content).split(" ");

        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: aiResponse?.id ?? `msg_${Math.random().toString(36).substring(2, 14)}`,
              type: "message",
              role: "assistant",
              model: model.id,
              content: [],
              usage: { input_tokens: cost.inputTokens, output_tokens: 0 },
            },
          })}\n\n`
        );
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`
        );

        for (const word of words) {
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: word + " " },
            })}\n\n`
          );
        }

        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: cost.outputTokens },
          })}\n\n`
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
        return;
      }

      res.status(200).json(aiResponse);
    } catch (err) {
      next(err);
    }
  });

  // 5. Structured JSON error handling middleware
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    if (err instanceof SyntaxError && "body" in (err as unknown as Record<string, unknown>)) {
      res.setHeader("Connection", "close");
      res.status(400).json({
        error: "Malformed JSON in request body",
        details: err.message,
      });
      return;
    }

    if (
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      (err as { statusCode: number }).statusCode === 504
    ) {
      const msg = err instanceof Error ? err.message : "Upstream AI request timed out";
      res.status(504).json({
        error: "Upstream AI inference timed out",
        details: msg,
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: "Internal Server Error",
      details: message,
    });
  });

  return app;
}
