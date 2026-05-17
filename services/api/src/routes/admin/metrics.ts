// Admin metrics endpoint — proxies operator-scoped SQL queries against
// Cloudflare's Analytics Engine SQL API and returns the result as JSON for
// the panel dashboard.
//
// Why a proxy rather than letting the panel call CF directly: the CF
// account-level API token is held server-side (wrangler secret on the
// api Worker). The panel reaches services/api over a service binding, so
// admin operators don't need a CF token in their browser.
//
// SQL surface: the panel can only invoke pre-defined queries (whitelist
// below). Allowing arbitrary SQL would expose the entire account's
// Analytics Engine — including future datasets — to anyone with an
// `admin:read` token.
import { Hono } from 'hono';
import { requireScope } from '../../auth.js';
import { buildError } from '../../errors.js';
import type { Env } from '../../env.js';

export const metrics = new Hono<{ Bindings: Env }>();

interface SQLApiRow {
  [k: string]: unknown;
}

interface SQLApiResponse {
  meta?: Array<{ name: string; type: string }>;
  data?: SQLApiRow[];
  rows?: number;
  rows_before_limit_at_least?: number;
}

const DATASET = 'polaris_metrics';

// Whitelist of canned queries. The `:window_seconds` placeholder is
// substituted from the request's `window` query param (24h / 7d / 30d).
// All queries are read-only and scoped to the polaris_metrics dataset.
const QUERIES: Record<string, (windowSeconds: number) => string> = {
  inbound_by_domain: (w) => `
    SELECT index1 AS domain, SUM(_sample_interval * double1) AS count
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '${w}' SECOND
      AND blob1 = 'received'
    GROUP BY domain
    ORDER BY count DESC
    LIMIT 50
  `,
  outbound_by_status: (w) => `
    SELECT index1 AS domain, blob1 AS status, SUM(_sample_interval * double1) AS count
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '${w}' SECOND
      AND blob1 IN ('sent','bounced')
    GROUP BY domain, status
    ORDER BY count DESC
    LIMIT 200
  `,
  webhook_p95_latency: (w) => `
    SELECT index1 AS sub_id,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms,
           SUM(_sample_interval) AS deliveries
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '${w}' SECOND
    GROUP BY sub_id
    ORDER BY deliveries DESC
    LIMIT 50
  `,
};

function windowSeconds(w: string): number {
  if (w === '7d') return 7 * 24 * 3600;
  if (w === '30d') return 30 * 24 * 3600;
  return 24 * 3600;
}

async function runSQL(env: Env, sql: string): Promise<SQLApiResponse> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID required for metrics SQL API');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'text/plain',
    },
    body: sql,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`SQL API ${r.status}: ${txt.slice(0, 256)}`);
  }
  return (await r.json()) as SQLApiResponse;
}

metrics.get('/v1/admin/metrics/:query', requireScope('admin:read'), async (c) => {
  const queryName = c.req.param('query');
  const queryFn = QUERIES[queryName];
  if (!queryFn) return buildError(c, 'not_found', `unknown metrics query ${queryName}`);
  const windowParam = c.req.query('window') ?? '24h';
  if (!['24h', '7d', '30d'].includes(windowParam)) {
    return buildError(c, 'bad_request', 'window must be one of 24h, 7d, 30d');
  }
  const sql = queryFn(windowSeconds(windowParam));
  try {
    const result = await runSQL(c.env, sql);
    return c.json({ query: queryName, window: windowParam, data: result.data ?? [] });
  } catch (e) {
    return buildError(c, 'degraded', e instanceof Error ? e.message : 'metrics_failed');
  }
});

// Discovery endpoint — lists available queries so the panel can render a
// dynamic dashboard without hardcoding query names.
metrics.get('/v1/admin/metrics', requireScope('admin:read'), (c) =>
  c.json({ queries: Object.keys(QUERIES) }),
);
