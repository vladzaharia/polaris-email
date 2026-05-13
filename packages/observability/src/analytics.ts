// Workers Analytics Engine writes for per-domain metrics.
//
// Analytics Engine retains data for 90 days; daily rollup cron writes the
// per-domain aggregates to R2 as Parquet for historical queries (I21).
//
// One dataset per metric family. We keep the schema small to fit AE's
// blob/double slot model:
//   blob1 = domain
//   blob2 = tenant_id
//   blob3 = event_type (sent, failed, bounced, received, webhook_delivered, ...)
//   blob4 = error_class (when applicable; '' otherwise)
//   double1 = value (count or latency_ms)
//   index1 = domain (for partitioning queries)

export interface AnalyticsBinding {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface AnalyticsEnv {
  /** Configured via wrangler.toml `[[analytics_engine_datasets]]`. */
  ANALYTICS?: AnalyticsBinding;
}

/** Record a counter event (sent / failed / bounced / received). */
export function recordEvent(
  env: AnalyticsEnv,
  opts: {
    domain: string;
    tenantId: string;
    eventType: string;
    errorClass?: string;
    count?: number;
  }
): void {
  if (!env.ANALYTICS) return; // not configured (e.g., dev / test); drop silently
  env.ANALYTICS.writeDataPoint({
    blobs: [opts.domain, opts.tenantId, opts.eventType, opts.errorClass ?? ''],
    doubles: [opts.count ?? 1],
    indexes: [opts.domain],
  });
}

/** Record a latency measurement (e.g., request latency, send latency). */
export function recordLatency(
  env: AnalyticsEnv,
  opts: {
    domain: string;
    tenantId: string;
    measurement: string; // e.g., 'send_ms', 'verify_ms'
    valueMs: number;
  }
): void {
  if (!env.ANALYTICS) return;
  env.ANALYTICS.writeDataPoint({
    blobs: [opts.domain, opts.tenantId, opts.measurement, ''],
    doubles: [opts.valueMs],
    indexes: [opts.domain],
  });
}
