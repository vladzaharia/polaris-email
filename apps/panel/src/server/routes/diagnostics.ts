import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

// `state` distinguishes "intentionally missing config" from "broken". Stage 1
// of the panel overhaul tightened the contract: previously every check was
// `ok: boolean` which collapsed those two cases into "fail".
export type CheckState = 'ok' | 'fail' | 'config_needed' | 'skipped';

interface Check {
  name: string;
  state: CheckState;
  detail?: string;
  remedy?: string;
}

export const diagnosticsRoutes = new Hono<{ Bindings: Env }>();

diagnosticsRoutes.get('/api/diagnostics', async (c) => {
  const polaris = makePolaris(c.env);
  const checks: Check[] = [];
  try {
    const r = await polaris.call('GET', '/healthz');
    checks.push({ name: 'api_healthz', state: r.status === 200 ? 'ok' : 'fail' });
  } catch (e) {
    checks.push({ name: 'api_healthz', state: 'fail', detail: String(e) });
  }
  try {
    const r = await polaris.call('GET', '/v1/admin/audit/chain-status');
    const body = r.body as { head?: { id?: number } };
    checks.push({
      name: 'audit_chain',
      state: r.status === 200 && (body.head?.id ?? -1) >= 0 ? 'ok' : 'fail',
      detail: JSON.stringify(body),
    });
  } catch (e) {
    checks.push({ name: 'audit_chain', state: 'fail', detail: String(e) });
  }
  // CF zones reachability — a 503 with code `cf_credentials_missing` means
  // the operator just hasn't seeded the CF API token yet; flag as
  // config_needed so the page doesn't read as broken.
  try {
    const r = await polaris.call('GET', '/v1/admin/cf-zones');
    if (r.status === 200) {
      checks.push({ name: 'cf_zones', state: 'ok' });
    } else if (r.status === 503) {
      const body = r.body as { error?: { code?: string; message?: string } };
      if (body.error?.code === 'cf_credentials_missing') {
        checks.push({
          name: 'cf_zones',
          state: 'config_needed',
          detail: body.error.message,
          remedy: 'polaris-mail setup infra secrets seed',
        });
      } else {
        checks.push({ name: 'cf_zones', state: 'fail', detail: JSON.stringify(body) });
      }
    } else {
      checks.push({ name: 'cf_zones', state: 'fail', detail: `HTTP ${r.status}` });
    }
  } catch (e) {
    checks.push({ name: 'cf_zones', state: 'fail', detail: String(e) });
  }
  const ok = checks.every((x) => x.state === 'ok');
  return c.json({ ok, checks });
});
