// Inbound sync loop: poll polaris-email for new messages, MessageImport into Mox.
import type { MoxClient } from './mox-client.js';
import type { PolarisClient } from './polaris-client.js';

export interface SyncDeps {
  polaris: PolarisClient;
  mox: MoxClient;
  /** Mailbox id → mox account name. */
  mailboxes: Map<string, { account: string }>;
  /** Cancel signal for shutdown. */
  signal: AbortSignal;
  /** Poll interval ms. */
  intervalMs: number;
  /** Optional callback for tests / observability. */
  onCycle?: (cycle: { imported: number; failed: number; errors: string[] }) => void;
  /**
   * Optional per-tick drain of the api Worker's pending-Mox-ops queue.
   * Runs after syncOnce. Exceptions are swallowed so the inbound loop never
   * halts because of an admin-side op failure.
   */
  drainMoxOps?: () => Promise<void>;
}

interface PendingMessage {
  id: string;
  mailbox_id: string;
  r2_signed_url: string;
}

interface PendingResponse {
  data: PendingMessage[];
}

export async function syncOnce(deps: SyncDeps): Promise<{ imported: number; failed: number; errors: string[] }> {
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const [mailboxId, { account }] of deps.mailboxes) {
    const r = await deps.polaris.request<PendingResponse>(
      'GET',
      `/v1/mailboxes/${mailboxId}/messages`,
      undefined,
      'undelivered_to_imap=1&limit=50',
    );
    if (r.status === 200 && Array.isArray((r.body as PendingResponse | undefined)?.data)) {
      for (const msg of (r.body as PendingResponse).data) {
        try {
          const bytes = await fetch(msg.r2_signed_url, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!bytes.ok) {
            failed++;
            errors.push(`fetch ${msg.id}: ${bytes.status}`);
            continue;
          }
          const buf = Buffer.from(await bytes.arrayBuffer());
          const imp = await deps.mox.messageImport({ account, rfc822: buf });
          await deps.polaris.request(
            'POST',
            `/v1/messages/${msg.id}/imap-delivered`,
            { uid: imp.uid, uidvalidity: imp.uidvalidity },
          );
          imported++;
        } catch (e) {
          failed++;
          errors.push(`${msg.id}: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }
    }
  }
  deps.onCycle?.({ imported, failed, errors });
  return { imported, failed, errors };
}

export async function runSyncLoop(deps: SyncDeps): Promise<void> {
  while (!deps.signal.aborted) {
    try {
      await syncOnce(deps);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('sync-loop error', e);
    }
    if (deps.drainMoxOps) {
      try {
        await deps.drainMoxOps();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('mox-ops drain error', e);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, deps.intervalMs));
  }
}
