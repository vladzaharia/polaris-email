// polaris-email-tail: centralised error sink for all production Workers.
//
// Wired as a `tail_consumers` entry from services/api, services/in,
// services/out, apps/panel. CF Workers Tail delivers a TraceItem batch per
// upstream invocation; we filter for the configured severities and POST a
// structured payload to ALERT_WEBHOOK so operators see errors in real time.
//
// Threat model note: ALERT_WEBHOOK is operator-configured (rendered from
// .env.deploy at deploy time), not user input. The SSRF guard used by
// services/api's webhook fan-out (queue/ssrf.ts) defends against
// customer-configured webhook URLs; that's a different surface. Here we
// rely on the operator not pointing ALERT_WEBHOOK at internal IPs, so
// plain `fetch` is sufficient.
import type { Env } from './env.js';

type ForwardLevel = 'log' | 'info' | 'warn' | 'error' | 'fatal' | 'debug';

interface LogPayload {
  worker: string;
  outcome: string;
  ray_id?: string;
  request_id?: string;
  url?: string;
  method?: string;
  level: string;
  message: unknown;
  ts: number;
}

function parseLevels(raw: string | undefined): Set<ForwardLevel> {
  const fallback: Set<ForwardLevel> = new Set(['error', 'fatal']);
  if (!raw) return fallback;
  const out = new Set<ForwardLevel>();
  for (const part of raw.split(',').map((s) => s.trim().toLowerCase())) {
    if (
      part === 'log' ||
      part === 'info' ||
      part === 'warn' ||
      part === 'error' ||
      part === 'fatal' ||
      part === 'debug'
    ) {
      out.add(part);
    }
  }
  // `error` and `fatal` are always forwarded — an empty/garbage
  // TAIL_FORWARD_LEVELS shouldn't silently mute the panic path.
  out.add('error');
  out.add('fatal');
  return out;
}

function eventMatchesLevel(
  ev: TraceItem,
  levels: Set<ForwardLevel>,
): { level: ForwardLevel; message: unknown } | null {
  // Always forward exceptions regardless of console.* output. CF emits
  // them as a separate field on TraceItem so console-quiet panics still
  // reach the alert sink.
  if (ev.outcome === 'exception' || ev.outcome === 'exceededCpu') {
    const msg = ev.exceptions?.[0];
    return { level: 'error', message: msg ?? { reason: ev.outcome } };
  }
  for (const log of ev.logs ?? []) {
    const lvl = log.level as ForwardLevel | undefined;
    if (lvl && levels.has(lvl)) {
      return { level: lvl, message: log.message };
    }
  }
  return null;
}

function summariseEventSource(ev: TraceItem): {
  url?: string;
  method?: string;
  ray_id?: string;
} {
  const evt = ev.event as unknown;
  if (!evt || typeof evt !== 'object') return {};
  // fetch trigger
  if ('request' in evt) {
    const req = (evt as { request?: { url?: string; method?: string; cf?: { rayId?: string } } })
      .request;
    return { url: req?.url, method: req?.method, ray_id: req?.cf?.rayId };
  }
  // scheduled trigger
  if ('cron' in evt) return { url: `cron:${(evt as { cron: string }).cron}` };
  // queue trigger
  if ('queue' in evt) return { url: `queue:${(evt as { queue: string }).queue}` };
  // email trigger
  if ('rawSize' in evt) return { url: 'email' };
  return {};
}

async function forward(env: Env, payload: LogPayload): Promise<void> {
  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    // We deliberately swallow forwarder errors. A failed alert post must
    // never crash the tail consumer; CF Workers Logs still has the original
    // entry as a fallback record.
    // eslint-disable-next-line no-console
    console.error(
      'tail: forwarder error',
      e instanceof Error ? e.message : String(e),
      'payload.worker',
      payload.worker,
    );
  }
}

export default {
  async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> {
    const levels = parseLevels(env.TAIL_FORWARD_LEVELS);
    for (const ev of events) {
      const match = eventMatchesLevel(ev, levels);
      if (!match) continue;
      const src = summariseEventSource(ev);
      await forward(env, {
        worker: ev.scriptName ?? 'unknown',
        outcome: ev.outcome,
        ray_id: src.ray_id,
        url: src.url,
        method: src.method,
        level: match.level,
        message: match.message,
        ts: ev.eventTimestamp ?? Date.now(),
      });
    }
  },
};
