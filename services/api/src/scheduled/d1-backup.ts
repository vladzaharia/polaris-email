// Weekly D1 export → R2 backups prefix. Cron: `0 6 * * 0` (Sunday 06:00 UTC).
//
// Why: D1 Time-Travel covers ~30 days of point-in-time recovery, but only
// while the database itself exists. Operator-owned weekly exports stored
// in R2 (and lifecycled to 12 weeks) provide:
//   * a recovery path if the D1 database is accidentally deleted
//     (Time-Travel cannot resurrect a destroyed DB);
//   * a forensic snapshot for compliance audits;
//   * a base for restoring into a separate D1 instance for incident
//     drills without touching production state.
//
// The export uses the CF D1 polling export API
// (POST /accounts/{id}/d1/database/{db}/export). The first call returns
// a `polling` status with a bookmark; subsequent calls advance until
// the export is complete and surface a signed URL. We then stream the
// signed URL bytes straight into R2 under `backups/d1/YYYY-MM-DD.sql`.
//
// Failures are non-fatal: a missed weekly backup is operator-investigatable
// via cron_runs but does not cascade. The next week's run will succeed
// once the underlying transient is gone.
import type { Env } from '../env.js';
import { recordCronRun } from './cron-runs.js';

interface ExportResponse {
  success?: boolean;
  errors?: { message: string }[];
  result?: {
    at_bookmark?: string;
    status?: 'active' | 'complete' | 'error';
    signed_url?: string;
    filename?: string;
    messages?: string[];
    error?: string;
  };
}

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 30; // ~60s total — D1 exports for a polaris-email-sized DB are seconds.

async function callExport(
  env: Env,
  databaseId: string,
  bookmark: string | null,
): Promise<ExportResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${databaseId}/export`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      output_format: 'polling',
      ...(bookmark ? { current_bookmark: bookmark } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`d1 export ${r.status}: ${txt.slice(0, 256)}`);
  }
  return (await r.json()) as ExportResponse;
}

async function resolveDatabaseId(env: Env): Promise<string> {
  // The D1 database_id binding doesn't surface its UUID at runtime — we
  // need it for the export REST endpoint. Look it up via the REST API
  // listing using the CF token. Cached lookups would be nice; at one
  // call per week this is a non-issue.
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database?name=polaris-email`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`d1 list ${r.status}: ${txt.slice(0, 256)}`);
  }
  const j = (await r.json()) as {
    result?: { uuid?: string; name?: string }[];
  };
  const match = (j.result ?? []).find((d) => d.name === 'polaris-email');
  if (!match?.uuid) throw new Error('d1 list: polaris-email not found');
  return match.uuid;
}

export async function d1Backup(env: Env): Promise<void> {
  const start = Date.now();
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    await recordCronRun(
      env,
      'd1-backup',
      'skipped',
      Date.now() - start,
      'CF_API_TOKEN / CF_ACCOUNT_ID required',
    );
    return;
  }
  try {
    const databaseId = await resolveDatabaseId(env);

    // Kick off + poll until complete / error / timeout.
    let bookmark: string | null = null;
    let signedUrl: string | null = null;
    let filename: string | null = null;
    for (let i = 0; i < MAX_POLLS; i++) {
      const resp = await callExport(env, databaseId, bookmark);
      if (!resp.success) {
        const msg = resp.errors?.[0]?.message ?? 'unknown';
        throw new Error(`d1 export error: ${msg}`);
      }
      const r = resp.result;
      if (!r) throw new Error('d1 export: empty result');
      if (r.status === 'error') throw new Error(`d1 export error: ${r.error ?? 'unknown'}`);
      bookmark = r.at_bookmark ?? bookmark;
      if (r.status === 'complete' && r.signed_url) {
        signedUrl = r.signed_url;
        filename = r.filename ?? 'export.sql';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!signedUrl) throw new Error('d1 export: timed out before complete');

    // Stream the signed URL straight into R2. R2's put() accepts a
    // ReadableStream so we don't buffer the entire dump in memory.
    const dl = await fetch(signedUrl, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) throw new Error(`d1 export download ${dl.status}`);
    if (!dl.body) throw new Error('d1 export download: empty body');

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const r2Key = `backups/d1/${date}-${filename}`;
    await env.R2.put(r2Key, dl.body, {
      httpMetadata: {
        contentType: 'application/sql',
        cacheControl: 'private, no-store',
      },
      customMetadata: {
        source: 'd1-export',
        database: 'polaris-email',
        exported_at: new Date().toISOString(),
      },
    });

    await recordCronRun(env, 'd1-backup', 'ok', Date.now() - start, `wrote ${r2Key}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordCronRun(env, 'd1-backup', 'error', Date.now() - start, msg);
    throw e;
  }
}
