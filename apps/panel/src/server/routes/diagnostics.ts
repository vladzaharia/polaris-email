import { Hono } from 'hono';
import type { Env } from '../env.js';
import { makePolaris } from '../polaris.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export const diagnosticsRoutes = new Hono<{ Bindings: Env }>();

diagnosticsRoutes.get('/api/diagnostics', async (c) => {
  const polaris = makePolaris(c.env);
  const checks: Check[] = [];
  try {
    const r = await polaris.call('GET', '/healthz');
    checks.push({ name: 'api_healthz', ok: r.status === 200 });
  } catch (e) {
    checks.push({ name: 'api_healthz', ok: false, detail: String(e) });
  }
  try {
    const r = await polaris.call('GET', '/v1/admin/audit/chain-status');
    const body = r.body as { head?: { id?: number } };
    checks.push({
      name: 'audit_chain',
      ok: r.status === 200 && (body.head?.id ?? -1) >= 0,
      detail: JSON.stringify(body),
    });
  } catch (e) {
    checks.push({ name: 'audit_chain', ok: false, detail: String(e) });
  }
  try {
    const r = await polaris.call('GET', '/v1/admin/tenants');
    checks.push({ name: 'tenants_listable', ok: r.status === 200 });
  } catch (e) {
    checks.push({ name: 'tenants_listable', ok: false, detail: String(e) });
  }
  const ok = checks.every((x) => x.ok);
  return c.json({ ok, checks });
});
