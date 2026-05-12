// Drain the api Worker's pending-Mox-ops queue.
//
// The Cloudflare Worker cannot reach the bridge sidecar over the Tailnet, so we
// invert the relationship: the api Worker enqueues plaintext-bearing ops in D1,
// and the sidecar polls + acks them here. Plaintext lives in D1 for ~1 tick
// (≈5s) before the sidecar acks and the janitor scrubs.
//
// SECURITY: `payload_b64` and its decoded plaintext MUST NEVER be logged.
// All log lines below use redactOp() to strip the payload before stringifying.
import type { MoxClient } from './mox-client.js';
import type { PolarisClient } from './polaris-client.js';

export interface PendingOp {
  id: string;
  op: 'set_password' | 'remove_account' | string;
  username: string;
  payload_b64: string | null;
  attempts: number;
}

export interface DrainDeps {
  polaris: PolarisClient;
  mox: MoxClient;
}

interface RedactedOp {
  id: string;
  op: string;
  username: string;
  attempts: number;
  has_payload: boolean;
}

function redactOp(op: PendingOp): RedactedOp {
  return {
    id: op.id,
    op: op.op,
    username: op.username,
    attempts: op.attempts,
    has_payload: op.payload_b64 != null,
  };
}

async function ackOp(
  polaris: PolarisClient,
  id: string,
  body: { ok: boolean; error?: string },
): Promise<void> {
  await polaris.request('POST', `/v1/bridge/mox-ops/${id}/ack`, body);
}

export async function drainMoxOpsOnce(deps: DrainDeps): Promise<{
  processed: number;
  acked: number;
  failed: number;
}> {
  const r = await deps.polaris.request<{ ops: PendingOp[] }>('GET', '/v1/bridge/mox-ops');
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.ops)) {
    return { processed: 0, acked: 0, failed: 0 };
  }
  let acked = 0;
  let failed = 0;
  for (const op of r.body.ops) {
    // Pulling plaintext out for the Mox call. The local binding is the entire
    // surface area where plaintext exists in this process. We zero it on exit.
    let plaintext = '';
    try {
      if (op.op === 'set_password') {
        if (!op.payload_b64) throw new Error('set_password op missing payload_b64');
        plaintext = Buffer.from(op.payload_b64, 'base64').toString('utf8');
        const ok = await deps.mox.setAccountPassword(op.username, plaintext);
        // Best-effort memory hygiene. JS strings are immutable, but reassigning
        // drops the reference so the GC can reclaim the buffer promptly.
        plaintext = '';
        if (!ok) throw new Error('mox setAccountPassword returned false');
        await ackOp(deps.polaris, op.id, { ok: true });
        acked++;
      } else if (op.op === 'remove_account') {
        const ok = await deps.mox.removeAccount(op.username);
        if (!ok) throw new Error('mox removeAccount returned false');
        await ackOp(deps.polaris, op.id, { ok: true });
        acked++;
      } else {
        // Unknown op — record a failure ack so the operator can investigate.
        await ackOp(deps.polaris, op.id, { ok: false, error: `unknown op: ${op.op}` });
        failed++;
      }
    } catch (e) {
      plaintext = '';
      const msg = e instanceof Error ? e.message : 'unknown';
      // SECURITY: redactOp() strips payload_b64 from the log line.
      // eslint-disable-next-line no-console
      console.warn(`mox-ops: op failed: ${msg}`, redactOp(op));
      try {
        await ackOp(deps.polaris, op.id, { ok: false, error: msg });
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.warn(
          `mox-ops: ack failed: ${e2 instanceof Error ? e2.message : 'unknown'}`,
          redactOp(op),
        );
      }
      failed++;
    } finally {
      plaintext = '';
    }
  }
  return { processed: r.body.ops.length, acked, failed };
}
