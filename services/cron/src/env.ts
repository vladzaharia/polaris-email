export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  // anchor
  ANCHOR_R2_PREFIX: string;
  ANCHOR_SIGNING_KEY?: string;
  // staleness + synthetic alerts
  ALERT_WEBHOOK: string;
  // synthetic
  API_BASE_URL: string;
  MAX_LATENCY_MS: string;
}
