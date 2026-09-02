import { describe, it, expect, beforeEach } from "vitest";
import { MetricsRegistry } from "../../src/server/metrics.js";

describe("Prometheus MetricsRegistry", () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it("should track and serialize counter metrics", () => {
    const counter = registry.createCounter({
      name: "test_requests_total",
      help: "Total number of test requests",
      labelNames: ["method", "status"],
    });

    counter.inc({ method: "POST", status: "200" });
    counter.inc({ method: "POST", status: "200" }, 2);
    counter.inc({ method: "GET", status: "402" }, 1);

    const output = registry.serialize();
    expect(output).toContain("# HELP test_requests_total Total number of test requests");
    expect(output).toContain("# TYPE test_requests_total counter");
    expect(output).toContain('test_requests_total{method="POST",status="200"} 3');
    expect(output).toContain('test_requests_total{method="GET",status="402"} 1');
  });

  it("should track and serialize gauge metrics", () => {
    const gauge = registry.createGauge({
      name: "test_queue_depth",
      help: "Current queue depth",
      labelNames: ["shard"],
    });

    gauge.set({ shard: "0" }, 42);
    gauge.inc({ shard: "0" }, 5);
    gauge.dec({ shard: "0" }, 2);
    gauge.set({ shard: "1" }, 10);

    const output = registry.serialize();
    expect(output).toContain("# HELP test_queue_depth Current queue depth");
    expect(output).toContain("# TYPE test_queue_depth gauge");
    expect(output).toContain('test_queue_depth{shard="0"} 45');
    expect(output).toContain('test_queue_depth{shard="1"} 10');
  });

  it("should track and serialize histogram metrics with buckets", () => {
    const histogram = registry.createHistogram({
      name: "test_duration_seconds",
      help: "Request duration in seconds",
      labelNames: ["endpoint"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1.0],
    });

    histogram.observe({ endpoint: "/verify" }, 0.02);
    histogram.observe({ endpoint: "/verify" }, 0.08);
    histogram.observe({ endpoint: "/verify" }, 0.45);
    histogram.observe({ endpoint: "/verify" }, 1.5);

    const output = registry.serialize();
    expect(output).toContain("# HELP test_duration_seconds Request duration in seconds");
    expect(output).toContain("# TYPE test_duration_seconds histogram");
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="0.01"} 0');
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="0.05"} 1');
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="0.1"} 2');
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="0.5"} 3');
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="1"} 3');
    expect(output).toContain('test_duration_seconds_bucket{endpoint="/verify",le="+Inf"} 4');
    expect(output).toContain('test_duration_seconds_count{endpoint="/verify"} 4');
  });

  it("should serve /metrics in Prometheus exposition format on facilitator and gateway", async () => {
    const { createFacilitatorServer } = await import("../../src/server/facilitator_server.js");
    const { createBlockRunGateway } = await import("../../src/gateway/blockrun_gateway.js");
    const request = (await import("supertest")).default;

    const mockVerifier = {
      verify: async () => ({ isValid: true }),
    };
    const mockQueue = {
      enqueue: async () => ({ success: true, transaction: "tx-123", network: "multiversx:1" }),
      getShardStats: () => ({ 0: { pending: 0, completed: 0, failed: 0 } }),
    };

    const facilitatorApp = createFacilitatorServer({
      verifier: mockVerifier as any,
      settlementQueue: mockQueue as any,
      rateLimit: { enabled: false },
    });

    const gatewayApp = createBlockRunGateway({
      verifier: mockVerifier as any,
      settlementQueue: mockQueue as any,
      payTo: "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th",
      rateLimit: { enabled: false },
    });

    const facRes = await request(facilitatorApp).get("/metrics");
    expect(facRes.status).toBe(200);
    expect(facRes.headers["content-type"]).toContain("text/plain");
    expect(facRes.text).toContain("# HELP");

    const gwRes = await request(gatewayApp).get("/metrics");
    expect(gwRes.status).toBe(200);
    expect(gwRes.headers["content-type"]).toContain("text/plain");
    expect(gwRes.text).toContain("# HELP");
  });
});
