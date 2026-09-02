/**
 * Prometheus exposition format telemetry collector and registry.
 * Zero-dependency, lightweight, high-performance metrics implementation.
 */

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: string[];
}

export interface HistogramOptions extends MetricOptions {
  buckets?: number[];
}

export type Labels = Record<string, string | number>;

function formatLabels(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) {
    return "";
  }
  const pairs = Object.entries(labels).map(
    ([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`
  );
  return `{${pairs.join(",")}}`;
}

function serializeKey(labels?: Labels): string {
  if (!labels) return "";
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(sorted);
}

export class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(public readonly options: MetricOptions) {}

  public inc(labels?: Labels, value: number = 1): void {
    const key = serializeKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, { labels: labels || {}, value });
    }
  }

  public serialize(): string {
    const lines: string[] = [
      `# HELP ${this.options.name} ${this.options.help}`,
      `# TYPE ${this.options.name} counter`,
    ];
    for (const entry of this.values.values()) {
      lines.push(`${this.options.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(public readonly options: MetricOptions) {}

  public set(labels: Labels | undefined, value: number): void {
    const key = serializeKey(labels);
    this.values.set(key, { labels: labels || {}, value });
  }

  public inc(labels?: Labels, value: number = 1): void {
    const key = serializeKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.values.set(key, { labels: labels || {}, value });
    }
  }

  public dec(labels?: Labels, value: number = 1): void {
    this.inc(labels, -value);
  }

  public serialize(): string {
    const lines: string[] = [
      `# HELP ${this.options.name} ${this.options.help}`,
      `# TYPE ${this.options.name} gauge`,
    ];
    for (const entry of this.values.values()) {
      lines.push(`${this.options.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
    return lines.join("\n");
  }
}

export class Histogram {
  private buckets: number[];
  private entries = new Map<
    string,
    {
      labels: Labels;
      sum: number;
      count: number;
      bucketCounts: number[];
    }
  >();

  constructor(public readonly options: HistogramOptions) {
    this.buckets = [...(options.buckets ?? [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])].sort(
      (a, b) => a - b
    );
  }

  public observe(labels: Labels | undefined, value: number): void {
    const key = serializeKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        labels: labels || {},
        sum: 0,
        count: 0,
        bucketCounts: new Array(this.buckets.length).fill(0),
      };
      this.entries.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        entry.bucketCounts[i] += 1;
      }
    }
  }

  public serialize(): string {
    const lines: string[] = [
      `# HELP ${this.options.name} ${this.options.help}`,
      `# TYPE ${this.options.name} histogram`,
    ];

    for (const entry of this.entries.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLabels = { ...entry.labels, le: this.buckets[i] };
        lines.push(
          `${this.options.name}_bucket${formatLabels(bucketLabels)} ${entry.bucketCounts[i]}`
        );
      }
      const infLabels = { ...entry.labels, le: "+Inf" };
      lines.push(`${this.options.name}_bucket${formatLabels(infLabels)} ${entry.count}`);
      lines.push(`${this.options.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.options.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }

    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private counters: Counter[] = [];
  private gauges: Gauge[] = [];
  private histograms: Histogram[] = [];

  public createCounter(options: MetricOptions): Counter {
    const counter = new Counter(options);
    this.counters.push(counter);
    return counter;
  }

  public createGauge(options: MetricOptions): Gauge {
    const gauge = new Gauge(options);
    this.gauges.push(gauge);
    return gauge;
  }

  public createHistogram(options: HistogramOptions): Histogram {
    const histogram = new Histogram(options);
    this.histograms.push(histogram);
    return histogram;
  }

  public serialize(): string {
    const sections: string[] = [];

    for (const c of this.counters) {
      const s = c.serialize();
      if (s) sections.push(s);
    }
    for (const g of this.gauges) {
      const s = g.serialize();
      if (s) sections.push(s);
    }
    for (const h of this.histograms) {
      const s = h.serialize();
      if (s) sections.push(s);
    }

    return sections.join("\n\n") + "\n";
  }
}

/**
 * Global default metrics registry for the BlockRun MultiversX stack.
 */
export const defaultMetricsRegistry = new MetricsRegistry();

export const httpRequestsTotal = defaultMetricsRegistry.createCounter({
  name: "blockrun_requests_total",
  help: "Total number of HTTP requests processed by endpoint and status code",
  labelNames: ["method", "endpoint", "status"],
});

export const paymentsSettledTotal = defaultMetricsRegistry.createCounter({
  name: "blockrun_payments_settled_total",
  help: "Total number of on-chain x402 payments settled",
  labelNames: ["network", "asset", "shard"],
});

export const spendMicroUsdcTotal = defaultMetricsRegistry.createCounter({
  name: "blockrun_spend_microusdc_total",
  help: "Total compute spend collected in micro-USDC",
  labelNames: ["model"],
});

export const settlementDurationSeconds = defaultMetricsRegistry.createHistogram({
  name: "blockrun_settlement_duration_seconds",
  help: "Latency of on-chain settlement transactions in seconds",
  labelNames: ["shard"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const queueDepthGauge = defaultMetricsRegistry.createGauge({
  name: "blockrun_queue_depth",
  help: "Current number of transactions waiting in shard settlement queue",
  labelNames: ["shard"],
});

export const relayerBalanceGauge = defaultMetricsRegistry.createGauge({
  name: "blockrun_relayer_balance_egld",
  help: "Current relayer wallet native EGLD balance",
  labelNames: ["shard", "relayer_address"],
});
