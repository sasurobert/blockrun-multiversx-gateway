import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import {
  MvxAddressSchema,
  SettleRequestSchema,
  VerifyRequestSchema,
} from "../domain/schemas.js";
import {
  SupportedKind,
  SupportedResponse,
} from "../domain/types.js";
import { IVerifierService } from "../services/verifier.js";
import { ISettlementQueue } from "../services/settlement_queue.js";
import { RelayerPoolManager } from "../services/relayer_pool.js";
import {
  buildPaymentResponseHeaders,
  extractPaymentPayload,
} from "../utils/header_utils.js";
import { generateOpenApiSpec } from "./openapi.js";
import { defaultMetricsRegistry } from "./metrics.js";

/**
 * Rate limiting configuration options.
 */
export interface RateLimitConfig {
  windowMs?: number;
  max?: number;
  enabled?: boolean;
}

/**
 * Options for configuring the Facilitator HTTP Server.
 */
export interface FacilitatorServerOptions {
  verifier: IVerifierService;
  settlementQueue: ISettlementQueue;
  relayerPool?: RelayerPoolManager;
  supportedNetworks?: string[];
  supportedKinds?: SupportedKind[];
  extensions?: string[];
  corsOrigins?: string | string[] | boolean;
  rateLimit?: RateLimitConfig;
  trustProxy?: boolean | string | number;
  version?: string;
  name?: string;
  description?: string;
}

/**
 * Simple, efficient in-memory rate limiting middleware.
 */
function createRateLimiter(config?: RateLimitConfig) {
  if (config?.enabled === false) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const windowMs = config?.windowMs ?? 60 * 1000;
  const maxRequests = config?.max ?? 120;
  const clientRequests = new Map<string, { count: number; resetTime: number }>();

  // Prune expired entries periodically to prevent memory leaks
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

    let record = clientRequests.get(ip);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      clientRequests.set(ip, record);
    } else {
      record.count++;
    }

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
 * Creates and configures an Express application for the x402 MultiversX Facilitator.
 */
export function createFacilitatorServer(options: FacilitatorServerOptions): Express {
  const app = express();

  if (options.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy);
  }

  const facilitatorName = options.name ?? "BlockRun MultiversX x402 Facilitator Gateway";
  const facilitatorVersion = options.version ?? "2.0.0";
  const extensions = options.extensions ?? ["bazaar", "relayed-v3"];
  const supportedNetworks = options.supportedNetworks ?? [
    "multiversx:1",
    "multiversx:D",
    "multiversx:T",
  ];

  const supportedKinds: SupportedKind[] =
    options.supportedKinds ??
    supportedNetworks.map((net) => ({
      x402Version: 2,
      scheme: "exact",
      network: net,
    }));

  // Build signers map from RelayerPoolManager
  const relayerSignersList = options.relayerPool
    ? Object.values(options.relayerPool.getAllRelayerAddresses())
    : [];

  const signersRecord: Record<string, string[]> = {};
  for (const net of supportedNetworks) {
    signersRecord[net] = relayerSignersList;
  }

  const supportedResponse: SupportedResponse = {
    kinds: supportedKinds,
    extensions,
    signers: signersRecord,
  };

  // 1. Security Headers (Helmet)
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
        "PAYMENT-RESPONSE",
        "payment-response",
        "X-Payment-Receipt",
        "x-payment-receipt",
        "X-Payment-Settled",
        "x-payment-settled",
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

  // 3. Body parser
  app.use(express.json({ limit: "1mb" }));

  // 4. Rate Limiting
  app.use(createRateLimiter(options.rateLimit));

  // --- Endpoints ---

  /**
   * GET /health
   * Facilitator health and shard queue metrics.
   */
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: facilitatorVersion,
      queueStats: options.settlementQueue.getShardStats(),
      pendingCount: options.settlementQueue.getPendingCount(),
    });
  });

  /**
   * GET /supported
   * Facilitator supported kinds, extensions, and network signers.
   */
  app.get("/supported", (_req: Request, res: Response) => {
    res.json(supportedResponse);
  });

  /**
   * GET /.well-known/x402
   * Protocol discovery document.
   */
  app.get("/.well-known/x402", (_req: Request, res: Response) => {
    res.json({
      x402Version: 2,
      name: facilitatorName,
      version: facilitatorVersion,
      supported: supportedResponse,
      endpoints: {
        verify: "/verify",
        settle: "/settle",
        supported: "/supported",
        health: "/health",
        relayerAddress: "/relayer/address/:userAddress",
        relayerShards: "/relayer/shards",
        openapi: "/openapi.json",
      },
    });
  });

  /**
   * GET /relayer/address/:userAddress
   * Resolves the relayer address and shard ID for a MultiversX user address.
   */
  app.get("/relayer/address/:userAddress", (req: Request, res: Response) => {
    if (!options.relayerPool) {
      res.status(503).json({
        error: "Relayer pool is not configured on this facilitator",
      });
      return;
    }

    const parseResult = MvxAddressSchema.safeParse(req.params.userAddress);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid MultiversX address format",
        details: parseResult.error.format(),
      });
      return;
    }

    try {
      const userAddress = parseResult.data;
      const shard = options.relayerPool.getShardForAddress(userAddress);
      const relayerAddress = options.relayerPool.getRelayerAddressForUser(userAddress);
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
    if (!options.relayerPool) {
      res.json({ relayers: {}, shards: [] });
      return;
    }

    const relayerMap = options.relayerPool.getAllRelayerAddresses();
    const shards = Object.keys(relayerMap).map(Number);
    res.json({ relayers: relayerMap, shards });
  });

  /**
   * GET /metrics
   * Prometheus metrics exposition format.
   */
  app.get("/metrics", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(defaultMetricsRegistry.serialize());
  });

  /**
   * POST /verify
   * Validates an x402 v2 payment payload.
   */
  app.post("/verify", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawBody = req.body || {};
      let paymentPayload = rawBody.paymentPayload;
      let paymentRequirements = rawBody.paymentRequirements;

      // Check header fallback for payment payload
      if (!paymentPayload) {
        paymentPayload = extractPaymentPayload(req.headers);
      }

      if (!paymentRequirements && paymentPayload?.accepted) {
        paymentRequirements = paymentPayload.accepted;
      }

      const candidate = {
        paymentPayload,
        paymentRequirements,
      };

      const parseResult = VerifyRequestSchema.safeParse(candidate);
      if (!parseResult.success) {
        res.status(400).json({
          error: "Invalid verify request",
          details: parseResult.error.format(),
        });
        return;
      }

      const verifyResult = await options.verifier.verify(parseResult.data);

      // Set standard x402 headers
      const responseHeaders = buildPaymentResponseHeaders(verifyResult);
      for (const [headerKey, headerValue] of Object.entries(responseHeaders)) {
        res.setHeader(headerKey, headerValue);
      }

      res.status(200).json(verifyResult);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /settle
   * Enqueues and settles an x402 v2 payment transaction.
   */
  app.post("/settle", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawBody = req.body || {};
      let paymentPayload = rawBody.paymentPayload;
      let paymentRequirements = rawBody.paymentRequirements;

      // Check header fallback for payment payload
      if (!paymentPayload) {
        paymentPayload = extractPaymentPayload(req.headers);
      }

      if (!paymentRequirements && paymentPayload?.accepted) {
        paymentRequirements = paymentPayload.accepted;
      }

      const candidate = {
        paymentPayload,
        paymentRequirements,
      };

      const parseResult = SettleRequestSchema.safeParse(candidate);
      if (!parseResult.success) {
        res.status(400).json({
          error: "Invalid settle request",
          details: parseResult.error.format(),
        });
        return;
      }

      const settleResult = await options.settlementQueue.enqueue(parseResult.data);

      // Set standard x402 headers
      const responseHeaders = buildPaymentResponseHeaders(settleResult);
      for (const [headerKey, headerValue] of Object.entries(responseHeaders)) {
        res.setHeader(headerKey, headerValue);
      }

      res.status(200).json(settleResult);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /openapi.json
   * Serves OpenAPI 3.1.0 specification.
   */
  app.get("/openapi.json", (_req: Request, res: Response) => {
    const spec = generateOpenApiSpec({
      title: facilitatorName,
      version: facilitatorVersion,
      description: options.description,
    });
    res.json(spec);
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

    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: "Internal Server Error",
      details: message,
    });
  });

  return app;
}
