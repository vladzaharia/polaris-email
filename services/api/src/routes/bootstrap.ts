// /v1/admin/bootstrap: one-time seed of the root operator + first admin key.
// Protected by POLARIS_SECRET_A (control-plane HMAC); idempotent (subsequent calls 409).
//
// Bootstrap creates the canonical "root" operator row (id
// `01J0000000000000000000ROOT`) and the admin api_key tied to it via
// `api_keys.operator_id`. The `bootstrap` table's single row acts as the
// gate (`consumed_at IS NULL`).
//
// PR 7 adds:
//   * `Idempotency-Key` header support — a replay with the same key
//     returns the *prior* successful response (admin_key_id + secret)
//     instead of 409, so the genesis-seal flow survives a transient
//     CLI-side restart between the POST and the on-disk capture.
//   * `already_bootstrapped` error code — distinct from the generic
//     `conflict` so the Go CLI can map it back to an idempotent skip
//     instead of an operator-visible failure.
//   * `webauthn_enrol_url` + `setup_code` in the response so the CLI
//     can open the operator's browser to the WebAuthn ceremony.
//   * `GET /v1/admin/setup/webauthn/<code>` poll endpoint so the CLI
//     can wait for the ceremony to complete (or expire after 5min).
import { Hono } from 'hono';
import type { Env } from '../env.js';
import { audit } from '../audit.js';
import { buildError } from '../errors.js';
import { hashSecret } from '../hashing.js';
import { ulid } from '@polaris-mail/ids';
import { generateSecret, verify } from '@polaris-mail/hmac';

export const bootstrap = new Hono<{ Bindings: Env }>();

// Idempotency-Key → cached response JSON. Stored in KV_IDEMPOTENCY with a
// 24h TTL — long enough that an operator who walks away mid-flow can
// resume on the same machine, short enough that a stale key doesn't haunt
// the namespace forever.
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24;
const IDEMPOTENCY_KEY_PREFIX = 'bootstrap:idem:';

// One-time setup codes (the value the CLI polls) are issued alongside
// each successful bootstrap. They expire 5 minutes after issue.
const SETUP_CODE_TTL_SECONDS = 60 * 5;
const SETUP_CODE_KEY_PREFIX = 'bootstrap:setup:';

interface SetupCodeRecord {
  status: 'pending' | 'complete' | 'expired';
  admin_key_id: string;
  issued_at: number;
}

bootstrap.post('/v1/admin/bootstrap', async (c) => {
  if (!c.env.POLARIS_SECRET_A) {
    return buildError(c, 'forbidden', 'POLARIS_SECRET_A not configured');
  }
  const bodyText = await c.req.text();
  const path = new URL(c.req.url).pathname;
  const query = new URL(c.req.url).search;
  // Bootstrap auth uses the polaris-api direction, signed with POLARIS_SECRET_A.
  const r = await verify({
    direction: 'polaris-api',
    method: 'POST',
    path,
    query,
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyText,
    secret: c.env.POLARIS_SECRET_A,
  });
  if (!r.ok) return buildError(c, 'bad_signature', `bootstrap auth: ${r.code}`);

  // Idempotency: if the caller supplied an Idempotency-Key header AND
  // the same key was used on a prior *successful* bootstrap, replay the
  // cached response. The KV value is the JSON body we returned the first
  // time; we re-emit it with the original status 200 so the CLI sees an
  // identical shape.
  const idemKey = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key');
  if (idemKey) {
    const cached = await c.env.KV_IDEMPOTENCY.get(IDEMPOTENCY_KEY_PREFIX + idemKey);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  // Existence check: if an admin key already exists in api_keys (status
  // primary, prefix pk_admin_), the bootstrap path is closed. We treat
  // the `bootstrap` table's consumed_at AS WELL AS the presence of any
  // admin key — either signal is sufficient, the two get out of sync if
  // someone wipes the bootstrap row out-of-band.
  const adminKey = await c.env.DB.prepare(
    `SELECT id FROM api_keys WHERE prefix = ? AND status = 'primary' LIMIT 1`,
  )
    .bind('pk_admin_')
    .first<{ id: string }>();
  if (adminKey) {
    return buildError(
      c,
      'already_bootstrapped',
      'bootstrap already completed; an admin key exists',
    );
  }

  // Idempotency: the bootstrap (id=1) row is seeded by 0001_init; if it's
  // already consumed, return 409. If the row doesn't exist (fresh test DB),
  // we'll INSERT it below alongside the consume.
  const row = await c.env.DB.prepare(
    `SELECT id, consumed_at, admin_key_id FROM bootstrap WHERE id = ?`,
  )
    .bind(1)
    .first<{ id: number; consumed_at: string | null; admin_key_id: string | null }>();
  if (row?.consumed_at) {
    return buildError(c, 'already_bootstrapped', 'bootstrap already consumed');
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // The bootstrap admin is the canonical "root" operator. A fixed id makes
  // it discoverable after the fact (e.g., the panel's operators detail page
  // surfaces the root badge for this id) and avoids spurious new operators
  // on re-bootstrap of a wiped dev environment.
  const operatorId = '01J0000000000000000000ROOT';
  const keyId = ulid();
  const secret = generateSecret();
  const hashed = await hashSecret(secret, c.env.ARGON2_PEPPER);

  // 1) Create (or reuse) the root operator. The bootstrap key now ships
  //    with admin:impersonate in its default scopes — Wish/SSH requires
  //    this to attribute SSH-fronted actions to the connecting operator.
  const existingOp = await c.env.DB.prepare(`SELECT id FROM operators WHERE id = ?`)
    .bind(operatorId)
    .first<{ id: string }>();
  if (!existingOp) {
    await c.env.DB.prepare(
      `INSERT INTO operators
         (id, name, email, ssh_pubkey, ssh_pubkey_fp_sha256, role,
          created_at, updated_at)
       VALUES (?, 'root', 'root@polaris-mail.invalid', '',
               'sha256:bootstrap-admin-no-pubkey', 'admin', ?, ?)`,
    )
      .bind(operatorId, nowIso, nowIso)
      .run();
  }

  // 2) The api_key itself, tied to the root operator.
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (id, operator_id, prefix, secret_argon2id, scopes,
        rate_limit_per_min, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'primary', ?)`,
  )
    .bind(
      keyId,
      operatorId,
      'pk_admin_',
      hashed,
      '["admin:rotate","admin:read","admin:impersonate"]',
      60,
      nowIso,
    )
    .run();
  await c.env.KV_KEY_CACHE.put(`plain:${keyId}`, secret, {
    expirationTtl: 60 * 60 * 24 * 365,
  });
  if (row) {
    await c.env.DB.prepare(`UPDATE bootstrap SET consumed_at = ?, admin_key_id = ? WHERE id = ?`)
      .bind(nowIso, keyId, 1)
      .run();
  } else {
    await c.env.DB.prepare(`INSERT INTO bootstrap (id, consumed_at, admin_key_id) VALUES (?, ?, ?)`)
      .bind(1, nowIso, keyId)
      .run();
  }
  await audit(c.env, {
    actor: 'bootstrap',
    action: 'bootstrap.consume',
    target: keyId,
    meta: { issued_at: now, operator_id: operatorId },
  });

  // Mint a one-time setup code so the CLI can poll for WebAuthn
  // completion. The code itself is opaque; the KV record carries the
  // status + which admin key was minted (so an out-of-band ceremony
  // observer can flip the status when the operator finishes).
  const setupCode = generateSecret();
  const setupRecord: SetupCodeRecord = {
    status: 'pending',
    admin_key_id: keyId,
    issued_at: now,
  };
  await c.env.KV_KEY_CACHE.put(SETUP_CODE_KEY_PREFIX + setupCode, JSON.stringify(setupRecord), {
    expirationTtl: SETUP_CODE_TTL_SECONDS,
  });

  // Build the operator-facing enrolment URL. We base it off API_BASE_URL
  // because there's no separate panel-URL binding in the API Worker's
  // env; operators with a distinct panel host can override via the
  // documented `PANEL_BASE_URL` route in a future PR. For now the panel
  // sits at the same origin (Cloudflare Access fronts both).
  const enrolBase = c.env.API_BASE_URL || `https://${new URL(c.req.url).host}`;
  const webauthnEnrolURL = `${enrolBase.replace(/\/$/, '')}/setup/webauthn?code=${setupCode}`;

  const responseBody = {
    admin_key_id: keyId,
    admin_key_secret: secret,
    operator_id: operatorId,
    setup_code: setupCode,
    webauthn_enrol_url: webauthnEnrolURL,
  };
  const responseJSON = JSON.stringify(responseBody);

  // Cache for idempotent replay when the caller supplied an Idempotency-Key.
  if (idemKey) {
    await c.env.KV_IDEMPOTENCY.put(IDEMPOTENCY_KEY_PREFIX + idemKey, responseJSON, {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  }

  return new Response(responseJSON, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

// GET /v1/admin/setup/webauthn/<code> — public poll endpoint the CLI
// hits every 2s while waiting for the operator to complete the WebAuthn
// ceremony in their browser. No HMAC required: the code itself is the
// unguessability boundary, and the response carries only status (no
// secrets). Mirrors the R2 public-domain convention — the SHA-256-class
// opaque code is the credential.
bootstrap.get('/v1/admin/setup/webauthn/:code', async (c) => {
  const code = c.req.param('code');
  if (!code || code.length < 8) {
    return c.json({ status: 'expired' as const });
  }
  const raw = await c.env.KV_KEY_CACHE.get(SETUP_CODE_KEY_PREFIX + code);
  if (!raw) {
    // Either never issued, or already expired out of KV.
    return c.json({ status: 'expired' as const });
  }
  let record: SetupCodeRecord;
  try {
    record = JSON.parse(raw) as SetupCodeRecord;
  } catch {
    return c.json({ status: 'expired' as const });
  }
  // Belt-and-suspenders TTL check: KV expirationTtl fires asynchronously,
  // so we double-check the issued_at against SETUP_CODE_TTL_SECONDS.
  if (Date.now() - record.issued_at > SETUP_CODE_TTL_SECONDS * 1000) {
    return c.json({ status: 'expired' as const });
  }
  return c.json({ status: record.status });
});

// POST /v1/admin/setup/webauthn/<code>/complete — invoked by the panel
// (or any operator-side ceremony driver) once the operator has finished
// the WebAuthn enrolment. Flips the cached record's status so the CLI's
// poll loop returns `complete` and exits. Auth: signed with the freshly
// minted admin key, so only the operator who *just* bootstrapped can
// complete a code.
bootstrap.post('/v1/admin/setup/webauthn/:code/complete', async (c) => {
  // We use the same HMAC-auth header set the admin routes use, but
  // verify against the just-minted admin key. Loading the key from the
  // KV_KEY_CACHE plaintext mirror keeps the route self-contained.
  const code = c.req.param('code');
  const raw = await c.env.KV_KEY_CACHE.get(SETUP_CODE_KEY_PREFIX + code);
  if (!raw) return buildError(c, 'not_found', 'setup code unknown or expired');
  let record: SetupCodeRecord;
  try {
    record = JSON.parse(raw) as SetupCodeRecord;
  } catch {
    return buildError(c, 'not_found', 'setup code unknown or expired');
  }
  if (Date.now() - record.issued_at > SETUP_CODE_TTL_SECONDS * 1000) {
    return buildError(c, 'not_found', 'setup code expired');
  }
  const bodyText = await c.req.text();
  const path = new URL(c.req.url).pathname;
  const query = new URL(c.req.url).search;
  const keySecret = await c.env.KV_KEY_CACHE.get(`plain:${record.admin_key_id}`);
  if (!keySecret) {
    return buildError(c, 'not_found', 'admin key secret unavailable');
  }
  const v = await verify({
    direction: 'polaris-api',
    method: 'POST',
    path,
    query,
    headers: { get: (n: string) => c.req.header(n) ?? null },
    body: bodyText,
    secret: keySecret,
  });
  if (!v.ok) return buildError(c, 'bad_signature', `setup complete auth: ${v.code}`);

  // Optional credential id stash for audit context. Body shape:
  // `{ "credential_id": "..." }` — both fields optional.
  let credentialId: string | null = null;
  try {
    const parsed = bodyText ? (JSON.parse(bodyText) as { credential_id?: string }) : {};
    if (typeof parsed.credential_id === 'string' && parsed.credential_id.length > 0) {
      credentialId = parsed.credential_id;
    }
  } catch {
    // Body is optional; ignore parse errors.
  }
  if (credentialId) {
    await c.env.DB.prepare(`UPDATE bootstrap SET webauthn_credential_id = ? WHERE id = 1`)
      .bind(credentialId)
      .run();
  }

  record.status = 'complete';
  await c.env.KV_KEY_CACHE.put(SETUP_CODE_KEY_PREFIX + code, JSON.stringify(record), {
    expirationTtl: SETUP_CODE_TTL_SECONDS,
  });
  await audit(c.env, {
    actor: record.admin_key_id,
    action: 'bootstrap.webauthn_enrolled',
    target: record.admin_key_id,
    meta: credentialId ? { credential_id: credentialId } : {},
  });
  return c.json({ status: 'complete' as const });
});
