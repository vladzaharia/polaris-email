import { Hono } from 'hono';
import type { PolarisClient } from '../polaris.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export function diagnosticsRoutes(polaris: PolarisClient) {
  const app = new Hono();
  app.get('/api/diagnostics', async (c) => {
    const checks: Check[] = [];
    // 1. api healthz
    try {
      const r = await polaris.call('GET', '/healthz');
      checks.push({ name: 'api_healthz', ok: r.status === 200 });
    } catch (e) {
      checks.push({ name: 'api_healthz', ok: false, detail: String(e) });
    }
    // 2. audit chain status
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
    // 3. services listing
    try {
      const r = await polaris.call('GET', '/v1/admin/services');
      checks.push({ name: 'services_listable', ok: r.status === 200 });
    } catch (e) {
      checks.push({ name: 'services_listable', ok: false, detail: String(e) });
    }
    const ok = checks.every((x) => x.ok);
    return c.json({ ok, checks });
  });
  return app;
}
