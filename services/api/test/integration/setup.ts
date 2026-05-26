// Integration test setup for services/api.
//
// Pattern: "near-integration" — we drive the real Hono Worker (`app.fetch`)
// end-to-end against the in-memory D1/KV/R2/Queue mocks from
// `../mocks.ts`. This catches the cross-module, cross-handler bugs that
// pure unit tests can't see (e.g. revocation propagation through KV, idempotency
// dedup at the pipeline boundary, secret leaks in GET handlers) without
// requiring a full miniflare boot with embedded SQLite.
//
// Why not miniflare-with-real-D1?
//   - Existing unit-test infra in `services/api/test/mocks.ts` already exercises
//     the real route handlers; the only difference is the storage substrate.
//   - The repo has zero miniflare/vitest-environment-miniflare wiring; adding
//     it cleanly would require a multi-day rework of `vitest.config.ts`,
//     a Wrangler-driven migration runner against in-memory SQLite, and
//     binding-override plumbing that the cleanup plan explicitly scopes out
//     of.
//   - The in-memory mocks honour the actual D1/KV semantics that A1 (revocation
//     propagation), A8 (composite idempotency PK), and A11 (read-once secrets)
//     depend on: KV.get/put with TTLs, D1 INSERT OR IGNORE, MockQueue.send.
//   - The bugs A12 was written to catch are observable at the handler boundary
//     — they are NOT storage-engine bugs.
//
// If/when we adopt vitest-environment-miniflare we should swap `mkEnv()` for
// a miniflare-backed env and the tests in this directory will keep working
// unchanged.

import { sign, generateNonce } from '@polaris-mail/hmac';
import { _clearRevocationCacheForTests } from '@polaris-mail/revocation';
import app from '../../src/index.js';
import { mkEnv } from '../mocks.js';
import type { Env } from '../../src/env.js';

export type IntegrationEnv = ReturnType<typeof mkEnv>;

export const ctx = {
  passThroughOnException: () => undefined,
  waitUntil: (p: Promise<unknown>) => p,
} as unknown as ExecutionContext;

// CF fetch stub is now installed by `mocks.ts` so every test that imports
// `mkEnv()` automatically gets the canned mint/revoke responses for
// `/user/tokens`. No-op for non-Cloudflare URLs.

/**
 * Wipe per-isolate module state that leaks between tests. The revocation
 * package keeps a process-wide cache; without this, a test that revokes
 * principal X will keep X revoked for any subsequent test that re-uses an
 * id-overlap (extremely unlikely with ulid() but possible).
 */
export function resetIsolateState(): void {
  _clearRevocationCacheForTests();
}

/** Sign-and-build a polaris-api HMAC request to the api Worker. */
export async function signedRequest(
  url: string,
  body: string,
  method: string,
  secret: string,
  keyId: string,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = generateNonce();
  const sig = await sign(
    {
      direction: 'polaris-api',
      method,
      path: u.pathname,
      query: u.search,
      ts,
      nonce,
      body,
    },
    secret,
  );
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-polaris-key-id': keyId,
      'x-polaris-ts': ts,
      'x-polaris-nonce': nonce,
      'x-polaris-sig': sig,
      ...extraHeaders,
    },
    body: method === 'GET' ? undefined : body,
  });
}

/** Boot a fresh env + run /v1/admin/bootstrap; return the issued admin key. */
export async function bootstrapEnv(overrides: Partial<Env> = {}): Promise<{
  env: IntegrationEnv;
  admin: { admin_key_id: string; admin_key_secret: string; operator_id: string };
}> {
  resetIsolateState();
  const env = mkEnv(overrides);
  const body = '{}';
  const req = await signedRequest(
    'https://x/v1/admin/bootstrap',
    body,
    'POST',
    env.POLARIS_SECRET_A!,
    '01HXR0000000000000000000A8',
  );
  // bootstrap bypasses hmacAuth middleware — strip the key-id so it routes
  // to the bootstrap-specific signature check.
  const cleanReq = new Request(req, {
    headers: (() => {
      const h = new Headers(req.headers);
      h.delete('x-polaris-key-id');
      return h;
    })(),
  });
  const res = await app.fetch(cleanReq, env, ctx);
  if (res.status !== 200) {
    throw new Error('bootstrap failed: ' + res.status + ' ' + (await res.text()));
  }
  const admin = (await res.json()) as {
    admin_key_id: string;
    admin_key_secret: string;
    operator_id: string;
  };
  return { env, admin };
}

/**
 * Test helper — register a mailbox_senders row so REST submissions with
 * `from = address` resolve to `mailboxId` via the from→mailbox lookup in
 * routes/messages.ts. Operator keys are not mailbox-bound after the
 * operators-split refactor; tests that want to submit messages from a
 * specific address must register the address with a mailbox first.
 */
export async function createSender(
  env: IntegrationEnv,
  opts: { mailboxId: string; domainId: string; address: string },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const localPart = opts.address.split('@')[0] ?? opts.address;
  await env.DB.prepare(
    `INSERT INTO mailbox_senders
       (id, mailbox_id, domain_id, address, local_part, default_for_mailbox, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      '01HX00SND' + Math.random().toString(36).slice(2, 16).toUpperCase().padEnd(17, 'A'),
      opts.mailboxId,
      opts.domainId,
      opts.address,
      localPart,
      nowIso,
    )
    .run();
}

export async function createMailbox(
  env: IntegrationEnv,
  admin: { admin_key_id: string; admin_key_secret: string },
  name: string,
): Promise<string> {
  const res = await app.fetch(
    await signedRequest(
      'https://x/v1/admin/mailboxes',
      JSON.stringify({ name }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
    env,
    ctx,
  );
  if (res.status !== 201) {
    throw new Error('createMailbox failed: ' + res.status + ' ' + (await res.text()));
  }
  return ((await res.json()) as { id: string }).id;
}

export async function issueApiKey(
  env: IntegrationEnv,
  admin: { admin_key_id: string; admin_key_secret: string },
  mailboxId: string,
  scopes: string[] = ['send'],
): Promise<{ key_id: string; key_secret: string }> {
  const res = await app.fetch(
    await signedRequest(
      'https://x/v1/admin/api-keys',
      JSON.stringify({ mailbox_id: mailboxId, scopes }),
      'POST',
      admin.admin_key_secret,
      admin.admin_key_id,
    ),
    env,
    ctx,
  );
  if (res.status !== 201) {
    throw new Error('issueApiKey failed: ' + res.status + ' ' + (await res.text()));
  }
  // Post-operators-split, the api_key is owned by a synthetic operator and
  // is not mailbox-bound. The REST submission path resolves the target
  // mailbox by looking up `mailbox_senders` for `req.from`, so test setup
  // needs at least one registered sender on the given mailbox. Register a
  // `noreply@<domain>` row for every verified domain to keep existing test
  // fixtures (which conventionally send from that address) working.
  const domains = await env.DB.prepare(
    `SELECT id, name FROM mail_domains WHERE status = 'verified'`,
  ).all<{ id: string; name: string }>();
  for (const d of domains.results) {
    await createSender(env, {
      mailboxId,
      domainId: d.id,
      address: `noreply@${d.name}`,
    }).catch(() => undefined);
  }
  return (await res.json()) as { key_id: string; key_secret: string };
}

export async function createVerifiedDomain(
  env: IntegrationEnv,
  domainName: string,
  ids: { id?: string; zone_id?: string } = {},
): Promise<string> {
  const id =
    ids.id ??
    '01HX00DOMAIN' + Math.random().toString(36).slice(2, 16).toUpperCase().padEnd(14, 'A');
  const zone_id =
    ids.zone_id ??
    '01HX00ZONE' + Math.random().toString(36).slice(2, 16).toUpperCase().padEnd(16, 'B');
  const isoNow = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, zone_id, domainName, 'verified', isoNow, isoNow, isoNow)
    .run();
  return id;
}

/** Re-export `app` so test files can import it through the integration setup. */
export { app };

/** Tiny RFC822 helper used by the SMTPS idempotency test. */
export function tinyRfc822(args: {
  subject: string;
  from: string;
  to: string;
  body: string;
  messageId?: string;
}): Uint8Array {
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    `Date: Mon, 1 Jan 2024 00:00:00 +0000`,
    `Message-ID: <${args.messageId ?? args.subject.replace(/\s+/g, '-')}@example.com>`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    args.body,
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}
