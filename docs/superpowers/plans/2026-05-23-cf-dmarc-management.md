# CF DMARC Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace polaris-mail's ARF-inbox DMARC ingest stack with a per-zone Cloudflare DMARC Management mirror. Polaris becomes a read-only view on CF aggregate data with an opt-in command path back into CF for policy advancement.

**Architecture:** New `packages/cf-api` surface (GraphQL client + DMARC Management REST helpers); new `dmarc-mirror` cron in `services/api` that polls CF GraphQL nightly and upserts the existing `dmarc_alignment_rollup` table; existing `dmarc-promote` cron rewired so its `publishDmarcRecord` stub becomes a real `setDmarcPolicy` call into CF. All ARF-inbox plumbing, the `dmarc-parser` package, the `dmarc_aggregate_reports` table, the platform-RUA mailbox, the `dmarc_rua` / `dmarc_record_managed_by_polaris` columns, the `dmarc.claim_management` audit action, and the panel "claim management" button are deleted.

**Tech Stack:** TypeScript / Cloudflare Workers / Hono / D1 / Cloudflare GraphQL Analytics + DMARC Management REST. No new dependencies.

**Reference:** `docs/superpowers/specs/2026-05-23-cf-dmarc-management-design.md`

---

### Task 1: D1 migration — drop legacy schema

**Files:**
- Create: `services/api/migrations/0005_cf_dmarc_management.sql`

- [ ] **Step 1: Inspect the existing audit_log CHECK constraint**

Run: `grep -A 80 'CREATE TABLE audit_log_new' services/api/migrations/0004_admin_alerts_dismissal.sql | head -90`

Expected: the full action allow-list including `'dmarc.promote','dmarc.pause','dmarc.rollback','dmarc.claim_management'`. Copy that list into the migration below verbatim, **minus** `'dmarc.claim_management'` and `'dmarc_aggregate_report.ingest'`.

- [ ] **Step 2: Write the migration**

```sql
-- 0005_cf_dmarc_management.sql
--
-- Cloudflare DMARC Management takes over polaris-mail's DMARC report
-- ingest. This migration drops the legacy ARF-inbox stack:
--
--   * dmarc_aggregate_reports — full per-report storage (CF holds these)
--   * mail_domains.dmarc_rua — operator's RUA tag (CF owns the record)
--   * mail_domains.dmarc_record_managed_by_polaris — CF always manages
--   * the platform-DMARC mailbox row + its dependents
--   * the dmarc.claim_management and dmarc_aggregate_report.ingest
--     audit actions (no longer reachable)
--
-- dmarc_alignment_rollup stays — the dmarc-mirror cron writes the same
-- shape from CF GraphQL aggregates.

DROP TABLE IF EXISTS dmarc_aggregate_reports;

ALTER TABLE mail_domains DROP COLUMN dmarc_rua;
ALTER TABLE mail_domains DROP COLUMN dmarc_record_managed_by_polaris;

DELETE FROM mailbox_senders   WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM mailbox_receivers WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM principals        WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM mailboxes         WHERE id          = '01HXPLATFORMDMARCREPORTS00';

-- audit_log CHECK rebuild — drop the two legacy actions from the allow
-- list. The chained-hash invariant is preserved because every row is
-- copied verbatim (prev_hash + row_hash carry over).
PRAGMA foreign_keys = OFF;

CREATE TABLE audit_log_new (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL CHECK(action IN (
              'bootstrap.consume',
              'bootstrap.webauthn_enrolled',
              'mailbox.create','mailbox.update','mailbox.disable','mailbox.delete',
              'mailbox.expunge',
              'mailbox_sender.create','mailbox_sender.update','mailbox_sender.disable','mailbox_sender.delete',
              'email_sender.create','email_sender.disable',
              'mailbox_receiver.create','mailbox_receiver.update','mailbox_receiver.disable','mailbox_receiver.delete',
              'routing_rule.create','routing_rule.update','routing_rule.delete',
              'api_key.issue','api_key.rotate','api_key.rotate.emergency','api_key.revoke',
              'api_key.revoke.emergency',
              'smtp_credential.issue','smtp_credential.disable','smtp_credential.rotate',
              'mailbox_credential.issue','mailbox_credential.rotate','mailbox_credential.disable',
              'dry_run_rotate',
              'bridge.register','bridge.rotate','bridge.deregister',
              'domain.create','domain.update','domain.disable',
              'domain.verify','domain.verify_incomplete','domain.dkim_rotate',
              'domain.inbound.enable','domain.inbound.disable',
              'domain.outbound.enable','domain.outbound.disable',
              'dkim_key.create','dkim_key.activate','dkim_key.retire',
              'webhook_sub.create','webhook_sub.update','webhook_sub.delete','webhook_sub.replay',
              'webhook_sub.test','webhook_sub.rotate',
              'message.submitted','message.received','message.marked_read','message.expunged',
              'rate_limit.exceeded',
              'cf_zone.configure',
              'mta_sts.enable','mta_sts.disable','mta_sts.promote',
              'tls_rpt.enable','tls_rpt.disable',
              'suppression.create','suppression.disable','suppression.import',
              'message.suppressed','message.sender_suppressed',
              'abuse_event.record',
              'admin.alert.sent',
              'admin.alert.dismiss',
              'admin.alert.dismiss_bulk',
              'sender_abuse_profile.tier_advance',
              'sender.suppress_auto',
              'tls_rpt_report.ingest',
              'dmarc.promote','dmarc.pause','dmarc.rollback',
              'dmarc.mgmt_enabled',
              'triage.classify',
              'triage.operator_override',
              'policy.decide',
              'policy.override',
              'message.held',
              'message.held_release',
              'message.held_drop',
              'moderation.feedback_recorded',
              'inbound_sender_block.create','inbound_sender_block.delete',
              'tenant.create','tenant.update','tenant.disable','tenant.rotate_pepper',
              'operator.create','operator.update','operator.disable',
              'operator.rotate_key','operator.rotate_pubkey',
              'auth.login','auth.logout'
            )),
  target    TEXT,
  meta      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash  TEXT NOT NULL
);

INSERT INTO audit_log_new (id, actor, action, target, meta, at, prev_hash, row_hash)
  SELECT id, actor, action, target, meta, at, prev_hash, row_hash FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_log_at     ON audit_log(at);
CREATE INDEX idx_audit_log_action ON audit_log(action, at);

PRAGMA foreign_keys = ON;
```

Note: this migration assumes the existing audit_log indexes match `idx_audit_log_at` + `idx_audit_log_action`. Confirm in Step 3 before committing; adjust if the names differ.

- [ ] **Step 3: Verify the audit_log index names match the originals**

Run: `grep -A 2 'CREATE INDEX.*audit_log' services/api/migrations/0001_init.sql services/api/migrations/0004_admin_alerts_dismissal.sql`

If the names in the migration above don't match the most recent definition, update them to match. Action: `at`-only index + `(action, at)` composite is the expected pair.

- [ ] **Step 4: Apply locally**

Run: `pnpm --filter @polaris-mail/api exec wrangler d1 migrations apply polaris-mail --local`

Expected: migration 0005 applies cleanly. If the audit-log rebuild errors out on a foreign-key reference, inspect the error and either disable that FK in the migration or copy/restore the referencing rows. (Foreign keys on `audit_log` are unlikely — it's a sink table.)

- [ ] **Step 5: Verify the schema**

Run:
```sh
pnpm --filter @polaris-mail/api exec wrangler d1 execute polaris-mail --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='dmarc_aggregate_reports';"
pnpm --filter @polaris-mail/api exec wrangler d1 execute polaris-mail --local --command "SELECT id FROM mailboxes WHERE id='01HXPLATFORMDMARCREPORTS00';"
pnpm --filter @polaris-mail/api exec wrangler d1 execute polaris-mail --local --command "PRAGMA table_info(mail_domains);"
```

Expected: first two queries return zero rows; the third no longer lists `dmarc_rua` or `dmarc_record_managed_by_polaris`.

- [ ] **Step 6: Commit**

```sh
git add services/api/migrations/0005_cf_dmarc_management.sql
git commit -m "feat(api/migrations): drop ARF-inbox DMARC schema for CF DMARC Management"
```

---

### Task 2: cf-api — GraphQL client primitive

**Files:**
- Create: `packages/cf-api/src/graphql.ts`
- Create: `packages/cf-api/test/graphql.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cf-api/test/graphql.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { graphqlQuery } from '../src/graphql.js';

function clientWithFetch(fetchImpl: typeof fetch): CloudflareApiClient {
  return new CloudflareApiClient({
    apiToken: 'tkn',
    accountId: 'acct',
    fetch: fetchImpl,
  });
}

describe('graphqlQuery', () => {
  it('POSTs to /client/v4/graphql with bearer auth and a JSON body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer tkn');
      expect(headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain('viewer');
      expect(body.variables).toEqual({ z: 'zone1' });
      return new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const r = await graphqlQuery<{ viewer: { zones: unknown[] } }>(client, {
      query: 'query($z: String!){ viewer { zones(filter: {zoneTag: $z}) { __typename } } }',
      variables: { z: 'zone1' },
    });
    expect(r.viewer.zones).toEqual([]);
  });

  it('throws on a GraphQL errors[] response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'bad zone' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    await expect(
      graphqlQuery(client, { query: '{ foo }', variables: {} }),
    ).rejects.toThrow(/bad zone/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/graphql.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the minimal client**

Inspect `packages/cf-api/src/client.ts` to confirm the shape of `CloudflareApiClient` (its `apiToken` + `fetch` accessors). Then:

```typescript
// packages/cf-api/src/graphql.ts
import type { CloudflareApiClient } from './client.js';

export interface GraphqlRequest<V = Record<string, unknown>> {
  query: string;
  variables?: V;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

export async function graphqlQuery<T, V = Record<string, unknown>>(
  client: CloudflareApiClient,
  req: GraphqlRequest<V>,
): Promise<T> {
  const fetchImpl = client.fetchImpl ?? fetch;
  const r = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: req.query, variables: req.variables ?? {} }),
  });
  if (!r.ok) {
    throw new Error(`cf graphql ${r.status}: ${await r.text()}`);
  }
  const body = (await r.json()) as GraphqlResponse<T>;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`cf graphql errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('cf graphql: missing data');
  return body.data;
}
```

If `CloudflareApiClient` does not expose `apiToken` and `fetchImpl` directly, add public getters for them (small, additive). Confirm by reading `client.ts` first.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/graphql.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```sh
git add packages/cf-api/src/graphql.ts packages/cf-api/test/graphql.test.ts packages/cf-api/src/client.ts
git commit -m "feat(cf-api): GraphQL POST client for /client/v4/graphql"
```

---

### Task 3: cf-api — DMARC Analytics GraphQL query

**Files:**
- Create: `packages/cf-api/src/dmarc-graphql.ts`
- Create: `packages/cf-api/test/dmarc-graphql.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cf-api/test/dmarc-graphql.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import { fetchDmarcAggregatesByDay } from '../src/dmarc-graphql.js';

describe('fetchDmarcAggregatesByDay', () => {
  it('queries dmarcReportsAdaptive by day for the given zone + date window', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain('dmarcReportsAdaptive');
      expect(body.variables).toEqual({
        zoneTag: 'cfz_x',
        since: '2026-05-21T00:00:00Z',
        until: '2026-05-23T23:59:59Z',
      });
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  dmarcReportsAdaptive: [
                    {
                      dimensions: { date: '2026-05-22', headerFrom: 'good.example' },
                      sum: {
                        totalCount: 100,
                        dmarcPassedCount: 99,
                        dkimPassedCount: 99,
                        spfPassedCount: 98,
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CloudflareApiClient({
      apiToken: 'tkn',
      accountId: 'acct',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const rows = await fetchDmarcAggregatesByDay(client, {
      zoneTag: 'cfz_x',
      since: '2026-05-21T00:00:00Z',
      until: '2026-05-23T23:59:59Z',
    });
    expect(rows).toEqual([
      {
        day: '2026-05-22',
        domain: 'good.example',
        totalCount: 100,
        dmarcPass: 99,
        dkimPass: 99,
        spfPass: 98,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/dmarc-graphql.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the query helper**

```typescript
// packages/cf-api/src/dmarc-graphql.ts
import type { CloudflareApiClient } from './client.js';
import { graphqlQuery } from './graphql.js';

export interface DmarcAggregateRow {
  day: string;       // YYYY-MM-DD
  domain: string;    // header-from domain
  totalCount: number;
  dmarcPass: number;
  dkimPass: number;
  spfPass: number;
}

export interface FetchDmarcAggregatesOpts {
  zoneTag: string;
  /** ISO-8601, inclusive lower bound. */
  since: string;
  /** ISO-8601, inclusive upper bound. */
  until: string;
}

const QUERY = `
query DmarcAggregatesByDay($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      dmarcReportsAdaptive(
        filter: { datetime_geq: $since, datetime_leq: $until }
        orderBy: [dimensions_date_ASC]
        limit: 10000
      ) {
        dimensions { date headerFrom }
        sum {
          totalCount
          dmarcPassedCount
          dkimPassedCount
          spfPassedCount
        }
      }
    }
  }
}
`;

interface RawResponse {
  viewer: {
    zones: Array<{
      dmarcReportsAdaptive: Array<{
        dimensions: { date: string; headerFrom: string };
        sum: {
          totalCount: number;
          dmarcPassedCount: number;
          dkimPassedCount: number;
          spfPassedCount: number;
        };
      }>;
    }>;
  };
}

export async function fetchDmarcAggregatesByDay(
  client: CloudflareApiClient,
  opts: FetchDmarcAggregatesOpts,
): Promise<DmarcAggregateRow[]> {
  const data = await graphqlQuery<RawResponse>(client, {
    query: QUERY,
    variables: { zoneTag: opts.zoneTag, since: opts.since, until: opts.until },
  });
  const zone = data.viewer.zones[0];
  if (!zone) return [];
  return zone.dmarcReportsAdaptive.map((row) => ({
    day: row.dimensions.date,
    domain: row.dimensions.headerFrom,
    totalCount: row.sum.totalCount,
    dmarcPass: row.sum.dmarcPassedCount,
    dkimPass: row.sum.dkimPassedCount,
    spfPass: row.sum.spfPassedCount,
  }));
}
```

**Schema note:** If `dmarcReportsAdaptive` rejects the `datetime_*` filter or expects `date_*` instead, adjust the query and the test variables together. The CF GraphQL Analytics schema is introspectable at `https://api.cloudflare.com/client/v4/graphql` (use the GraphQL Explorer) — verify field names there if the cron's first live call returns shape-drift warnings.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/dmarc-graphql.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cf-api/src/dmarc-graphql.ts packages/cf-api/test/dmarc-graphql.test.ts
git commit -m "feat(cf-api): dmarcReportsAdaptive aggregate-by-day query helper"
```

---

### Task 4: cf-api — DMARC Management REST helpers

**Files:**
- Create: `packages/cf-api/src/dmarc-management.ts`
- Create: `packages/cf-api/test/dmarc-management.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cf-api/test/dmarc-management.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from '../src/client.js';
import {
  enableDmarcManagement,
  getDmarcManagementStatus,
  setDmarcPolicy,
} from '../src/dmarc-management.js';

function clientWithFetch(fetchImpl: typeof fetch): CloudflareApiClient {
  return new CloudflareApiClient({
    apiToken: 'tkn',
    accountId: 'acct',
    fetch: fetchImpl,
  });
}

describe('enableDmarcManagement', () => {
  it('POSTs to /zones/{zone}/dmarc_management', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/zones/zone_x/dmarc_management');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({ success: true, result: { enabled: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const r = await enableDmarcManagement(clientWithFetch(fetchMock as unknown as typeof fetch), 'zone_x');
    expect(r.enabled).toBe(true);
  });

  it('treats "already enabled" (409 or specific error code) as success', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 'already_enabled', message: 'already enabled' }] }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await enableDmarcManagement(clientWithFetch(fetchMock as unknown as typeof fetch), 'zone_x');
    expect(r.enabled).toBe(true);
  });
});

describe('setDmarcPolicy', () => {
  it('PATCHes the zone DMARC Management policy', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/zones/zone_x/dmarc_management');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body.policy).toBe('quarantine');
      return new Response(JSON.stringify({ success: true, result: { policy: 'quarantine' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await setDmarcPolicy(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
      'quarantine',
    );
    expect(r.policy).toBe('quarantine');
  });
});

describe('getDmarcManagementStatus', () => {
  it('returns null when DMARC Management is not enabled (404)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 404 }),
    );
    const r = await getDmarcManagementStatus(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r).toBeNull();
  });

  it('returns the policy + enabled flag on 200', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, result: { enabled: true, policy: 'none' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await getDmarcManagementStatus(
      clientWithFetch(fetchMock as unknown as typeof fetch),
      'zone_x',
    );
    expect(r).toEqual({ enabled: true, policy: 'none' });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/dmarc-management.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

```typescript
// packages/cf-api/src/dmarc-management.ts
import type { CloudflareApiClient } from './client.js';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

export interface DmarcManagementStatus {
  enabled: boolean;
  policy: DmarcPolicy | null;
}

interface CfEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: string; message: string }>;
}

const ALREADY_ENABLED_HINTS = ['already_enabled', 'already enabled'];

function isAlreadyEnabled(body: CfEnvelope<unknown>): boolean {
  if (!body.errors) return false;
  return body.errors.some(
    (e) =>
      (e.code && ALREADY_ENABLED_HINTS.includes(e.code)) ||
      ALREADY_ENABLED_HINTS.some((h) => e.message?.toLowerCase().includes(h)),
  );
}

export async function enableDmarcManagement(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<{ enabled: true }> {
  const r = await client.post<CfEnvelope<{ enabled: boolean }>>(
    `/zones/${zoneId}/dmarc_management`,
    {},
  );
  if (r.success || isAlreadyEnabled(r)) return { enabled: true };
  throw new Error(
    `cf dmarc_management enable failed: ${r.errors?.map((e) => e.message).join('; ') ?? 'unknown'}`,
  );
}

export async function setDmarcPolicy(
  client: CloudflareApiClient,
  zoneId: string,
  policy: DmarcPolicy,
): Promise<{ policy: DmarcPolicy }> {
  const r = await client.patch<CfEnvelope<{ policy: DmarcPolicy }>>(
    `/zones/${zoneId}/dmarc_management`,
    { policy },
  );
  if (!r.success || !r.result) {
    throw new Error(
      `cf dmarc_management setPolicy failed: ${r.errors?.map((e) => e.message).join('; ') ?? 'unknown'}`,
    );
  }
  return { policy: r.result.policy };
}

export async function getDmarcManagementStatus(
  client: CloudflareApiClient,
  zoneId: string,
): Promise<DmarcManagementStatus | null> {
  try {
    const r = await client.get<CfEnvelope<{ enabled: boolean; policy: DmarcPolicy | null }>>(
      `/zones/${zoneId}/dmarc_management`,
    );
    if (!r.result) return null;
    return { enabled: r.result.enabled, policy: r.result.policy };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/^4(04|10)/.test(msg)) return null;
    throw err;
  }
}
```

**Endpoint note:** the URL pattern `/zones/{zone_id}/dmarc_management` is the documented base for the product (`https://developers.cloudflare.com/dmarc-management/`). If the actual production endpoint differs, update the three URL strings + the test expectations together — the rest of the helpers are pure transport.

- [ ] **Step 4: Confirm client.ts already exposes `get`, `post`, `patch` with `CfEnvelope`-aware error handling**

Run: `grep -n 'async \(get\|post\|patch\)' packages/cf-api/src/client.ts`

If `patch` is missing on the client, add a thin wrapper alongside `post`. Inspect the existing `post` to match its shape exactly.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run test/dmarc-management.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```sh
git add packages/cf-api/src/dmarc-management.ts packages/cf-api/test/dmarc-management.test.ts packages/cf-api/src/client.ts
git commit -m "feat(cf-api): DMARC Management REST helpers (enable, setPolicy, getStatus)"
```

---

### Task 5: cf-api — drop `_dmarc` TXT from `expectedRecordsFor()` + auto-enable DMARC Management during onboarding

**Files:**
- Modify: `packages/cf-api/src/email-service.ts`
- Modify: `packages/cf-api/test/discovery.test.ts` (and any other tests asserting the `_dmarc` record)

- [ ] **Step 1: Drop the `_dmarc` record from `expectedRecordsFor`**

In `packages/cf-api/src/email-service.ts`, remove the entire TXT block at lines 257–262:

```typescript
    {
      type: 'TXT',
      name: `_dmarc.${opts.domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${opts.domain}`,
      comment: 'polaris-mail: DMARC',
    },
```

- [ ] **Step 2: Wire `enableDmarcManagement` into `onboardSenderDomain`**

After the existing Email Service onboarding `try { … } catch` block (around line 96 in `email-service.ts`), before the manual-publish loop, add:

```typescript
  if (cfManaged) {
    try {
      await enableDmarcManagement(client, opts.zoneId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        'email-service: DMARC Management enable failed; onboarding continues, operator can retry',
        { domain: opts.domain, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }
```

Add the import at the top:

```typescript
import { enableDmarcManagement } from './dmarc-management.js';
```

- [ ] **Step 3: Update existing tests that asserted the `_dmarc` record**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run`

Expected: failures in tests that assert four expected records. Look for `_dmarc` literals in the test sources:

```sh
grep -rn "_dmarc" packages/cf-api/test/
```

Update each — the expected count drops from 4 to 3 (DKIM CNAME + SPF TXT + bounce MX, plus optional wildcard DKIM CNAME). Remove any `expectedRecords[i].name === '_dmarc.…'` assertions.

- [ ] **Step 4: Run cf-api tests to green**

Run: `pnpm --filter @polaris-mail/cf-api exec vitest run`

Expected: all PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cf-api/src/email-service.ts packages/cf-api/test/
git commit -m "feat(cf-api): auto-enable DMARC Management on onboard; drop _dmarc TXT publish"
```

---

### Task 6: services/api — new `dmarc-mirror` cron

**Files:**
- Create: `services/api/src/scheduled/dmarc-mirror.ts`
- Create: `services/api/test/integration/dmarc-mirror.workers.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// services/api/test/integration/dmarc-mirror.workers.test.ts
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { dmarcMirrorRun } from '../../src/scheduled/dmarc-mirror.js';
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

async function seedDomain(id: string, name: string, zoneId: string): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind('z_' + id, zoneId, name, now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'verified', ?, ?)`,
  )
    .bind(id, 'z_' + id, name, now, now)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, inject('migrations'));
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM mail_domains`).run();
  await testEnv.DB.prepare(`DELETE FROM zones`).run();
  await testEnv.DB.prepare(`DELETE FROM dmarc_alignment_rollup`).run();
});

describe('dmarc-mirror', () => {
  it('upserts dmarc_alignment_rollup rows from CF GraphQL aggregates', async () => {
    await seedDomain('d1', 'good.example', 'cfz_x');

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/client/v4/graphql');
      const body = JSON.parse(init?.body as string);
      expect(body.variables.zoneTag).toBe('cfz_x');
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              zones: [
                {
                  dmarcReportsAdaptive: [
                    {
                      dimensions: { date: '2026-05-22', headerFrom: 'good.example' },
                      sum: {
                        totalCount: 100,
                        dmarcPassedCount: 99,
                        dkimPassedCount: 99,
                        spfPassedCount: 98,
                      },
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetch: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(r.zones).toBe(1);
    expect(r.rowsUpserted).toBe(1);

    const row = await testEnv.DB.prepare(
      `SELECT total_count, dmarc_pass, dkim_pass, spf_pass FROM dmarc_alignment_rollup
       WHERE domain = 'good.example' AND day = '2026-05-22'`,
    ).first<{ total_count: number; dmarc_pass: number; dkim_pass: number; spf_pass: number }>();
    expect(row).toEqual({ total_count: 100, dmarc_pass: 99, dkim_pass: 99, spf_pass: 98 });
  });

  it('skips domains without a cf_zone and continues', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, created_at, updated_at)
       VALUES (?, NULL, ?, 'verified', ?, ?)`,
    )
      .bind('orphan', 'orphan.example', now, now)
      .run();

    const fetchMock = vi.fn();
    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetch: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.zones).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('tolerates a single zone failing and surfaces it in the result', async () => {
    await seedDomain('d1', 'good.example', 'cfz_x');
    await seedDomain('d2', 'bad.example', 'cfz_y');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      if (body.variables.zoneTag === 'cfz_y') {
        return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ data: { viewer: { zones: [{ dmarcReportsAdaptive: [] }] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const r = await dmarcMirrorRun(testEnv as unknown as Env, {
      fetch: fetchMock as unknown as typeof fetch,
      apiToken: 'tkn',
      accountId: 'acct',
    });
    expect(r.zones).toBe(2);
    expect(r.failed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm --filter @polaris-mail/api exec vitest run test/integration/dmarc-mirror.workers.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cron**

```typescript
// services/api/src/scheduled/dmarc-mirror.ts
import { CloudflareApiClient } from '@polaris-mail/cf-api';
import { fetchDmarcAggregatesByDay } from '@polaris-mail/cf-api/dmarc-graphql';
import type { Env } from '../env.js';

export interface DmarcMirrorResult {
  zones: number;
  rowsUpserted: number;
  failed: number;
  skipped: number;
}

interface DomainRow {
  id: string;
  name: string;
  cf_zone_id: string | null;
}

interface MirrorOverrides {
  fetch?: typeof fetch;
  apiToken?: string;
  accountId?: string;
}

function isoDayStart(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3_600_000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function isoDayEnd(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3_600_000);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

export async function dmarcMirrorRun(
  env: Env,
  overrides: MirrorOverrides = {},
): Promise<DmarcMirrorResult> {
  const result: DmarcMirrorResult = { zones: 0, rowsUpserted: 0, failed: 0, skipped: 0 };

  const domains = await env.DB.prepare(
    `SELECT d.id, d.name,
            COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
     FROM mail_domains d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.status = 'verified'`,
  ).all<DomainRow>();

  const apiToken = overrides.apiToken ?? env.CF_API_TOKEN;
  const accountId = overrides.accountId ?? env.CF_ACCOUNT_ID;
  if (!apiToken || !accountId) {
    return result;
  }

  const client = new CloudflareApiClient({
    apiToken,
    accountId,
    fetch: overrides.fetch,
  });

  const since = isoDayStart(2);
  const until = isoDayEnd(0);
  const nowIso = new Date().toISOString();

  for (const d of domains.results ?? []) {
    if (!d.cf_zone_id) {
      result.skipped++;
      continue;
    }
    result.zones++;
    try {
      const rows = await fetchDmarcAggregatesByDay(client, {
        zoneTag: d.cf_zone_id,
        since,
        until,
      });
      for (const r of rows) {
        await env.DB.prepare(
          `INSERT INTO dmarc_alignment_rollup
             (domain, day, reports, total_count, dmarc_pass, dkim_pass, spf_pass, last_seen_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(domain, day) DO UPDATE SET
             total_count = excluded.total_count,
             dmarc_pass = excluded.dmarc_pass,
             dkim_pass = excluded.dkim_pass,
             spf_pass = excluded.spf_pass,
             last_seen_at = excluded.last_seen_at`,
        )
          .bind(r.domain, r.day, r.totalCount, r.dmarcPass, r.dkimPass, r.spfPass, nowIso)
          .run();
        result.rowsUpserted++;
      }
    } catch (err) {
      result.failed++;
      // eslint-disable-next-line no-console
      console.warn('dmarc-mirror: zone failed', {
        domain: d.name,
        zone: d.cf_zone_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
```

Note on imports: the workspace alias `@polaris-mail/cf-api/dmarc-graphql` depends on the package's `exports` field. If `packages/cf-api/package.json` doesn't already wildcard-export the `src/*` files, fall back to a top-level re-export:

```typescript
// packages/cf-api/src/index.ts — add:
export { fetchDmarcAggregatesByDay } from './dmarc-graphql.js';
export type { DmarcAggregateRow, FetchDmarcAggregatesOpts } from './dmarc-graphql.js';
export { enableDmarcManagement, setDmarcPolicy, getDmarcManagementStatus } from './dmarc-management.js';
export type { DmarcManagementStatus, DmarcPolicy } from './dmarc-management.js';
```

Then `import { fetchDmarcAggregatesByDay } from '@polaris-mail/cf-api';` in the cron.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @polaris-mail/api exec vitest run test/integration/dmarc-mirror.workers.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```sh
git add services/api/src/scheduled/dmarc-mirror.ts services/api/test/integration/dmarc-mirror.workers.test.ts packages/cf-api/src/index.ts
git commit -m "feat(api): dmarc-mirror cron — mirror CF GraphQL aggregates into rollup table"
```

---

### Task 7: services/api — wire `dmarc-mirror` into scheduled dispatch + cron triggers

**Files:**
- Modify: `services/api/src/scheduled/index.ts`
- Modify: `services/api/wrangler.jsonc`

- [ ] **Step 1: Add the import + case to `scheduled/index.ts`**

In `services/api/src/scheduled/index.ts`, after the existing `dmarcPromoteRun` import (around line 28):

```typescript
import { dmarcMirrorRun } from './dmarc-mirror.js';
```

In the switch (around line 51, before the `dmarc-promote` case), add:

```typescript
    case '0 2 * * *':
      await withCronTelemetry(env, 'dmarc-mirror', async () => {
        const r = await dmarcMirrorRun(env);
        // eslint-disable-next-line no-console
        console.log(
          'dmarc-mirror cron:',
          `zones=${r.zones} rows=${r.rowsUpserted} failed=${r.failed} skipped=${r.skipped}`,
        );
      });
      return;
```

Also add a comment line in the dispatch banner near the top of the file (around line 8):

```
//   * `0 2 * * *`           — daily DMARC aggregate mirror          → dmarcMirrorRun
```

- [ ] **Step 2: Add the cron trigger to `wrangler.jsonc`**

In `services/api/wrangler.jsonc`, locate the `triggers.crons` array and add `"0 2 * * *"` to the list. Also update the inline comment table around the `triggers` block to document the new entry:

```
//   `0 2 * * *`    daily 02:00  → dmarc-mirror
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```sh
git add services/api/src/scheduled/index.ts services/api/wrangler.jsonc
git commit -m "feat(api/scheduled): register dmarc-mirror cron at 02:00 UTC"
```

---

### Task 8: services/api — rewire `dmarc-promote` to call `setDmarcPolicy`

**Files:**
- Modify: `services/api/src/scheduled/dmarc-promote.ts`
- Modify: `services/api/test/integration/dmarc-promote.workers.test.ts` (fixtures only; assertions still apply)

- [ ] **Step 1: Replace `publishDmarcRecord` with the real CF call**

In `services/api/src/scheduled/dmarc-promote.ts`:

Remove the existing `publishDmarcRecord` function (lines 97–108) and the `dmarc_record_managed_by_polaris` field on `DomainRow` and from the `SELECT … FROM mail_domains` SQL (the column no longer exists).

Replace the call site in `transition()` (lines 121–129) with:

```typescript
  let dnsPublished = false;
  let publishNote = '';
  if (newPolicy && (newState === 'quarantine' || newState === 'reject')) {
    try {
      const zoneId = await resolveCfZoneId(env, domain.id);
      if (!zoneId) {
        publishNote = 'mail_domains.cf_zone_id is NULL';
      } else {
        const client = new CloudflareApiClient({
          apiToken: env.CF_API_TOKEN,
          accountId: env.CF_ACCOUNT_ID,
        });
        await setDmarcPolicy(client, zoneId, newPolicy as 'quarantine' | 'reject');
        dnsPublished = true;
      }
    } catch (err) {
      publishNote = err instanceof Error ? err.message : String(err);
    }
  }
```

At the top of the file, add imports:

```typescript
import { CloudflareApiClient, setDmarcPolicy } from '@polaris-mail/cf-api';
```

Add the resolver near the bottom of the file (before `dmarcPromoteRun`):

```typescript
async function resolveCfZoneId(env: Env, domainId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
     FROM mail_domains d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.id = ?`,
  )
    .bind(domainId)
    .first<{ cf_zone_id: string | null }>();
  return row?.cf_zone_id ?? null;
}
```

- [ ] **Step 2: Drop the `dmarc_record_managed_by_polaris` column usage**

In `dmarc-promote.ts`, update:
- The `DomainRow` interface — remove `dmarc_record_managed_by_polaris`.
- The `SELECT` SQL in `dmarcPromoteRun` — remove `dmarc_record_managed_by_polaris` from the column list.
- Anywhere else that referenced the field.

- [ ] **Step 3: Update the integration test fixtures**

In `services/api/test/integration/dmarc-promote.workers.test.ts`:
- The `seedDomain` helper's INSERT must no longer set `dmarc_record_managed_by_polaris` (the column doesn't exist). Confirm by re-reading the file; the current INSERT does not set it, so this should be a no-op.
- No assertion changes needed — existing tests only check `dmarc_promotion_state`, which still works.

Add a new test asserting that auto-mode `setDmarcPolicy` is called on advancement:

```typescript
import { vi } from 'vitest';
// near the top, alongside existing imports

it('calls CF setDmarcPolicy when auto-mode advances into quarantine', async () => {
  const longAgo = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
  await seedDomain({
    id: 'd6',
    name: 'cfcall.example',
    state: 'quarantine_ready',
    promotionLastAt: longAgo,
  });
  await seedRollupDays('cfcall.example', 14, 99.9);

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain('/zones/');
    expect(url).toContain('/dmarc_management');
    expect(init?.method).toBe('PATCH');
    return new Response(
      JSON.stringify({ success: true, result: { policy: 'quarantine' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  // wire the mock onto env (the cron uses globalThis.fetch in production; in
  // tests we override via the env-level test rig used by other cf-api tests).
  (testEnv as TestEnv & { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string }).CF_API_TOKEN = 'tkn';
  (testEnv as TestEnv & { CF_API_TOKEN?: string; CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID = 'acct';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  try {
    const r = await dmarcPromoteRun(testEnv as unknown as Env);
    expect(r.promoted).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

Also seed a `zones` row with a `cf_zone_id` for `d6` in the test setup (the `seedDomain` helper already creates `zones (id, cf_zone_id, name)` rows — verify).

- [ ] **Step 4: Run the existing + new tests**

Run: `pnpm --filter @polaris-mail/api exec vitest run test/integration/dmarc-promote.workers.test.ts`

Expected: all PASS (including the new test).

- [ ] **Step 5: Commit**

```sh
git add services/api/src/scheduled/dmarc-promote.ts services/api/test/integration/dmarc-promote.workers.test.ts
git commit -m "refactor(api/dmarc-promote): wire setDmarcPolicy; drop dmarc_record_managed_by_polaris"
```

---

### Task 9: services/api — drop platform-RUA injection + `DMARC_RUA_PLATFORM_ALIAS` env var

**Files:**
- Modify: `services/api/src/routes/admin/domains.ts`
- Modify: `services/api/src/env.ts`

- [ ] **Step 1: Drop the platform-RUA injection**

In `services/api/src/routes/admin/domains.ts:178-182`, delete:

```typescript
  const platformDmarcRua = c.env.DMARC_RUA_PLATFORM_ALIAS ?? 'mailto:dmarc-rua@plrs.im';
  const rua = body.dmarc_rua ?? `mailto:postmaster@${body.name},${platformDmarcRua}`;
```

Remove anywhere `rua` was passed downstream. Since the `dmarc_rua` column was dropped in Task 1, also remove the `dmarc_rua` field from the INSERT into `mail_domains` (and the field from `body` type if it's listed there).

Drop any `dmarc_rua` references in the response shape returned by the route.

- [ ] **Step 2: Drop the env var declaration**

In `services/api/src/env.ts`, delete:

```typescript
  /**
   * Cloudflare-side RUA aggregator address (used for legacy ARF-inbox).
   *  `mailto:dmarc-rua@plrs.im`.
   */
  DMARC_RUA_PLATFORM_ALIAS?: string;
```

(Adjust the surrounding comment block — find the actual lines in the file via `grep -n 'DMARC_RUA_PLATFORM_ALIAS' services/api/src/env.ts`.)

- [ ] **Step 3: Drop the var from `services/api/wrangler.jsonc` if present**

Run: `grep -n DMARC_RUA_PLATFORM_ALIAS services/api/wrangler.jsonc services/api/wrangler.local.template.jsonc 2>/dev/null`

Remove any matches.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: no errors. If a route handler test compares a response shape that included `dmarc_rua`, update it.

- [ ] **Step 5: Commit**

```sh
git add services/api/src/routes/admin/domains.ts services/api/src/env.ts services/api/wrangler.jsonc services/api/wrangler.local.template.jsonc
git commit -m "refactor(api/admin/domains): drop platform DMARC RUA injection and env var"
```

---

### Task 10: services/api — `dmarc-reports` routes → live CF GraphQL

**Files:**
- Modify: `services/api/src/routes/admin/dmarc-reports.ts`

- [ ] **Step 1: Replace the list + detail SQL with GraphQL calls**

The summary endpoint stays as-is (reads `dmarc_alignment_rollup`). The list and detail endpoints become live GraphQL queries via the cf-api package.

Rewrite the file:

```typescript
// services/api/src/routes/admin/dmarc-reports.ts
//
// Admin REST for DMARC reports. Source of truth is Cloudflare DMARC
// Management; the per-(domain, day) rollup mirror in D1 is read by the
// summary endpoint to avoid hitting CF GraphQL on every panel pageview.
//
//   GET /v1/admin/dmarc-reports          → live CF GraphQL list (by zone/window)
//   GET /v1/admin/dmarc-reports/sources  → live CF GraphQL source-IP breakdown
//   GET /v1/admin/dmarc-reports/summary  → D1 dmarc_alignment_rollup (7d/14d/30d)

import { Hono } from 'hono';
import { CloudflareApiClient, fetchDmarcAggregatesByDay } from '@polaris-mail/cf-api';
import { requireScope } from '../../auth.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcReports = new Hono<{ Bindings: Env }>();

dmarcReports.get('/v1/admin/dmarc-reports', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  if (!domain) return buildError(c, 'bad_request', 'domain query param required');
  const days = Math.min(Math.max(Number(c.req.query('days') ?? '7'), 1), 90);

  const row = await c.env.DB.prepare(
    `SELECT COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
     FROM mail_domains d LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.name = ?`,
  )
    .bind(domain)
    .first<{ cf_zone_id: string | null }>();

  if (!row?.cf_zone_id) {
    return buildError(c, 'not_found', 'domain has no associated CF zone');
  }

  const until = new Date();
  until.setUTCHours(23, 59, 59, 999);
  const since = new Date(until.getTime() - days * 24 * 3_600_000);
  since.setUTCHours(0, 0, 0, 0);

  const client = new CloudflareApiClient({
    apiToken: c.env.CF_API_TOKEN,
    accountId: c.env.CF_ACCOUNT_ID,
  });

  try {
    const rows = await fetchDmarcAggregatesByDay(client, {
      zoneTag: row.cf_zone_id,
      since: since.toISOString(),
      until: until.toISOString(),
    });
    return c.json({ data: rows.filter((r) => r.domain === domain) });
  } catch (err) {
    return buildError(
      c,
      'upstream_error',
      `cf graphql: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

dmarcReports.get('/v1/admin/dmarc-reports/summary', requireScope('admin:read'), async (c) => {
  const domain = c.req.query('domain');
  if (!domain) return buildError(c, 'bad_request', 'domain query param required');
  const today = new Date().toISOString().slice(0, 10);
  const day7 = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);
  const day14 = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString().slice(0, 10);
  const day30 = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString().slice(0, 10);

  async function aggregate(sinceDay: string): Promise<{
    reports: number;
    total: number;
    dmarc_pass: number;
    dkim_pass: number;
    spf_pass: number;
    dmarc_pass_pct: number;
    dkim_pass_pct: number;
    spf_pass_pct: number;
    last_seen_at: string | null;
  }> {
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(reports), 0) AS reports,
              COALESCE(SUM(total_count), 0) AS total,
              COALESCE(SUM(dmarc_pass), 0) AS dmarc_pass,
              COALESCE(SUM(dkim_pass), 0) AS dkim_pass,
              COALESCE(SUM(spf_pass), 0) AS spf_pass,
              MAX(last_seen_at) AS last_seen_at
       FROM dmarc_alignment_rollup WHERE domain = ? AND day >= ?`,
    )
      .bind(domain, sinceDay)
      .first<{
        reports: number;
        total: number;
        dmarc_pass: number;
        dkim_pass: number;
        spf_pass: number;
        last_seen_at: string | null;
      }>();
    const total = row?.total ?? 0;
    const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 10000) / 100);
    return {
      reports: row?.reports ?? 0,
      total,
      dmarc_pass: row?.dmarc_pass ?? 0,
      dkim_pass: row?.dkim_pass ?? 0,
      spf_pass: row?.spf_pass ?? 0,
      dmarc_pass_pct: pct(row?.dmarc_pass ?? 0),
      dkim_pass_pct: pct(row?.dkim_pass ?? 0),
      spf_pass_pct: pct(row?.spf_pass ?? 0),
      last_seen_at: row?.last_seen_at ?? null,
    };
  }

  return c.json({
    domain,
    today,
    last_7d: await aggregate(day7),
    last_14d: await aggregate(day14),
    last_30d: await aggregate(day30),
  });
});
```

The old `/dmarc-reports/:id` detail route is dropped — there is no per-report ID in the CF rollup model. Panel detail view will use the date range against `/v1/admin/dmarc-reports`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: no errors.

- [ ] **Step 3: Run the api integration tests**

Run: `pnpm --filter @polaris-mail/api exec vitest run`

Expected: any prior tests against `/v1/admin/dmarc-reports/:id` fail. Locate and remove them — that endpoint is gone. Any tests against the list endpoint that asserted a D1-backed shape need their fetch mocks updated; see the cf-api mock pattern in Task 6's test.

- [ ] **Step 4: Commit**

```sh
git add services/api/src/routes/admin/dmarc-reports.ts services/api/test/
git commit -m "refactor(api/admin/dmarc-reports): live CF GraphQL list; drop per-report id route"
```

---

### Task 11: services/api — `dmarc-promotion` routes (drop claim-management, add `/advance`)

**Files:**
- Modify: `services/api/src/routes/admin/dmarc-promotion.ts`

- [ ] **Step 1: Rewrite the file**

```typescript
// services/api/src/routes/admin/dmarc-promotion.ts
//
// Admin REST over DMARC promotion state. Polaris recommends; operators
// (or the auto cron) advance via setDmarcPolicy into Cloudflare DMARC
// Management. Polaris no longer owns the _dmarc TXT record.
//
//   GET    /v1/admin/dmarc-promotion              — fleet view
//   POST   /v1/admin/dmarc-promotion/:id/pause    — manual pause
//   POST   /v1/admin/dmarc-promotion/:id/resume   — back to mode='auto'
//   POST   /v1/admin/dmarc-promotion/:id/advance  — operator advance via CF
//   POST   /v1/admin/dmarc-promotion/run          — manual cron trigger

import { Hono } from 'hono';
import { CloudflareApiClient, setDmarcPolicy } from '@polaris-mail/cf-api';
import { requireScope } from '../../auth.js';
import { actorOf, audit } from '../../audit.js';
import { dmarcPromoteRun } from '../../scheduled/dmarc-promote.js';
import type { Env } from '../../env.js';
import { buildError } from '../../errors.js';

export const dmarcPromotion = new Hono<{ Bindings: Env }>();

dmarcPromotion.get('/v1/admin/dmarc-promotion', requireScope('admin:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, name, dmarc_policy, dmarc_promotion_mode, dmarc_promotion_state,
            dmarc_promotion_last_at
     FROM mail_domains
     WHERE status NOT IN ('disabled')
     ORDER BY name`,
  ).all<{
    id: string;
    name: string;
    dmarc_policy: string | null;
    dmarc_promotion_mode: string;
    dmarc_promotion_state: string;
    dmarc_promotion_last_at: string | null;
  }>();
  return c.json({ data: rows.results ?? [] });
});

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/pause',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(
      `UPDATE mail_domains SET dmarc_promotion_mode = 'paused', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'domain not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.pause',
      target: id,
      meta: { source: 'operator' },
    });
    return c.json({ id, dmarc_promotion_mode: 'paused' });
  },
);

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/resume',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(
      `UPDATE mail_domains SET dmarc_promotion_mode = 'auto', updated_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (r.meta.changes === 0) return buildError(c, 'not_found', 'domain not found');
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.promote',
      target: id,
      meta: { source: 'resume', new_mode: 'auto' },
    });
    return c.json({ id, dmarc_promotion_mode: 'auto' });
  },
);

dmarcPromotion.post(
  '/v1/admin/dmarc-promotion/:id/advance',
  requireScope('admin:rotate'),
  async (c) => {
    const id = c.req.param('id');
    const domain = await c.env.DB.prepare(
      `SELECT d.id, d.name, d.dmarc_promotion_state,
              COALESCE(z.cf_zone_id, d.cf_zone_id) AS cf_zone_id
       FROM mail_domains d LEFT JOIN zones z ON z.id = d.zone_id
       WHERE d.id = ?`,
    )
      .bind(id)
      .first<{
        id: string;
        name: string;
        dmarc_promotion_state: string;
        cf_zone_id: string | null;
      }>();
    if (!domain) return buildError(c, 'not_found', 'domain not found');
    if (!domain.cf_zone_id) {
      return buildError(c, 'bad_request', 'domain has no associated CF zone');
    }

    const next = nextStateFor(domain.dmarc_promotion_state);
    if (!next) {
      return buildError(c, 'conflict', `cannot advance from state '${domain.dmarc_promotion_state}'`);
    }

    const client = new CloudflareApiClient({
      apiToken: c.env.CF_API_TOKEN,
      accountId: c.env.CF_ACCOUNT_ID,
    });
    try {
      await setDmarcPolicy(client, domain.cf_zone_id, next.policy);
    } catch (err) {
      return buildError(
        c,
        'upstream_error',
        `cf setDmarcPolicy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `UPDATE mail_domains
         SET dmarc_promotion_state = ?,
             dmarc_promotion_last_at = ?,
             dmarc_policy = ?,
             updated_at = ?
       WHERE id = ?`,
    )
      .bind(next.state, nowIso, next.policy, nowIso, id)
      .run();
    await audit(c.env, {
      actor: actorOf(c),
      action: 'dmarc.promote',
      target: id,
      meta: { source: 'operator_advance', from: domain.dmarc_promotion_state, to: next.state },
    });
    return c.json({ id, dmarc_promotion_state: next.state, dmarc_policy: next.policy });
  },
);

dmarcPromotion.post('/v1/admin/dmarc-promotion/run', requireScope('admin:rotate'), async (c) => {
  const r = await dmarcPromoteRun(c.env);
  return c.json(r);
});

function nextStateFor(state: string): { state: string; policy: 'quarantine' | 'reject' } | null {
  if (state === 'quarantine_ready') return { state: 'quarantine', policy: 'quarantine' };
  if (state === 'reject_ready') return { state: 'reject', policy: 'reject' };
  return null;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @polaris-mail/api typecheck`

Expected: no errors.

- [ ] **Step 3: Remove any test that asserted `claim-management`**

Run: `grep -rn 'claim[-_]management' services/api/test/`

Delete or rewrite each hit. Add a minimal test for the new `/advance` route:

```typescript
// services/api/test/integration/dmarc-promotion-advance.workers.test.ts
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { app } from '../../src/index.js'; // confirm the export name; adjust if different
import type { Env } from '../../src/env.js';

interface TestEnv extends Env {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, inject('migrations'));
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM mail_domains`).run();
  await testEnv.DB.prepare(`DELETE FROM zones`).run();
});

describe('POST /v1/admin/dmarc-promotion/:id/advance', () => {
  it('advances quarantine_ready → quarantine via setDmarcPolicy', async () => {
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO zones (id, cf_zone_id, name, created_at) VALUES ('z', 'cfz', 'good.example', ?)`,
    )
      .bind(now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO mail_domains (id, zone_id, name, status, dmarc_promotion_state, created_at, updated_at)
       VALUES ('d', 'z', 'good.example', 'verified', 'quarantine_ready', ?, ?)`,
    )
      .bind(now, now)
      .run();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/zones/cfz/dmarc_management');
      expect(init?.method).toBe('PATCH');
      return new Response(
        JSON.stringify({ success: true, result: { policy: 'quarantine' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      // Direct fetch through the app or the Hono client; adapt to whatever
      // test harness this repo uses elsewhere.
      const res = await app.request('/v1/admin/dmarc-promotion/d/advance', {
        method: 'POST',
        headers: { authorization: 'Bearer testkey' }, // adapt to local test auth
      }, testEnv);
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

If the existing repo uses a different test harness for HTTP-level tests, mirror the pattern from any other admin-route integration test (search `services/api/test/integration/` for an `app.request(` example) and adapt. If no in-process app fixture exists, skip the HTTP-level test and write a unit test against the handler closure instead.

- [ ] **Step 4: Run the api tests**

Run: `pnpm --filter @polaris-mail/api exec vitest run`

Expected: all PASS.

- [ ] **Step 5: Commit**

```sh
git add services/api/src/routes/admin/dmarc-promotion.ts services/api/test/
git commit -m "feat(api/admin/dmarc-promotion): /advance route; drop claim-management"
```

---

### Task 12: services/in — delete the ARF-inbox dispatch + ingest module

**Files:**
- Modify: `services/in/src/index.ts`
- Delete: `services/in/src/dmarc-ingest.ts`
- Delete: `services/in/test/integration/dmarc-ingest.workers.test.ts`

- [ ] **Step 1: Remove the import and dispatch**

In `services/in/src/index.ts`:
- Delete the import `handleDmarcReport` and `PLATFORM_DMARC_REPORTS_MAILBOX_ID` from `./dmarc-ingest.js`.
- Delete the `if (match.mailbox_id === PLATFORM_DMARC_REPORTS_MAILBOX_ID) { … }` branch around line 233.

- [ ] **Step 2: Delete the source + test**

```sh
git rm services/in/src/dmarc-ingest.ts services/in/test/integration/dmarc-ingest.workers.test.ts
```

- [ ] **Step 3: Run typecheck + tests**

Run:
```sh
pnpm --filter @polaris-mail/in typecheck
pnpm --filter @polaris-mail/in exec vitest run
```

Expected: all pass.

- [ ] **Step 4: Commit**

```sh
git add services/in/src/index.ts
git commit -m "refactor(in): drop ARF-inbox DMARC dispatch + ingest module"
```

---

### Task 13: Delete `packages/dmarc-parser` entirely

**Files:**
- Delete: `packages/dmarc-parser/` (whole directory)
- Modify: `pnpm-workspace.yaml` (if it lists the package explicitly)
- Modify: any `package.json` that depends on `@polaris-mail/dmarc-parser`

- [ ] **Step 1: Confirm zero remaining references**

Run: `grep -rn '@polaris-mail/dmarc-parser\|packages/dmarc-parser' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yaml'`

The Task 12 deletion of `dmarc-ingest.ts` was the only consumer — there should be zero remaining hits. If any remain, fix them before deletion.

- [ ] **Step 2: Delete the package**

```sh
git rm -r packages/dmarc-parser
```

- [ ] **Step 3: Remove from workspace + lockfile**

Inspect `pnpm-workspace.yaml`. If it lists `packages/dmarc-parser` explicitly, remove the entry. If it uses a glob (`packages/*`), no change needed.

Run: `pnpm install`

Expected: lockfile updates to remove `@polaris-mail/dmarc-parser`.

- [ ] **Step 4: Confirm root build**

Run: `pnpm -r build`

Expected: all workspaces build clean.

- [ ] **Step 5: Commit**

```sh
git add -A
git commit -m "chore: delete packages/dmarc-parser (replaced by CF DMARC Management)"
```

---

### Task 14: Update `packages/schema` test references

**Files:**
- Modify: `packages/schema/test/schema.test.ts`
- Modify: `packages/schema/src/index.ts` (if it exports a `dmarc_aggregate_reports` schema shape)

- [ ] **Step 1: Find references**

Run: `grep -rn 'dmarc_aggregate_reports\|dmarc_rua\|dmarc_record_managed_by_polaris\|PLATFORM_DMARC' packages/schema/`

- [ ] **Step 2: Drop them**

Remove any schema entries for the dropped table and columns. If the schema file constructs an exhaustive list of tables, drop `dmarc_aggregate_reports` from it.

- [ ] **Step 3: Run the schema tests**

Run: `pnpm --filter @polaris-mail/schema exec vitest run`

Expected: all pass.

- [ ] **Step 4: Commit**

```sh
git add packages/schema/
git commit -m "refactor(schema): drop dmarc_aggregate_reports + legacy columns"
```

---

### Task 15: Panel — drop claim-management, add `/advance`

**Files:**
- Modify: `apps/panel/src/client/pages/domains/Detail.tsx`
- Modify: `apps/panel/src/client/queryKeys.ts` (if needed)

- [ ] **Step 1: Drop the claim-management button + mutation**

In `apps/panel/src/client/pages/domains/Detail.tsx`, around line 973:

Delete the entire `claim-management` mutation block (the `useMutation` plus its button). It looked like:

```tsx
const claimManagement = useApiMutation(...)
...
<Button onClick={() => claimManagement.mutate({})}>Claim management</Button>
```

Also drop the `dmarc_record_managed_by_polaris` references — the badge around line 1025 and any reads from `promotion.dmarc_record_managed_by_polaris`.

- [ ] **Step 2: Add the advance button**

In the same `DmarcPromotionCard` component, gate a new "Advance now" button on `promotion.dmarc_promotion_state === 'quarantine_ready' || promotion.dmarc_promotion_state === 'reject_ready'`. Wire it to `useApiMutation` against `POST /api/admin/dmarc-promotion/${domainId}/advance`. Wrap the click in a `DestructiveActionDialog` confirmation (the existing component on the page).

Reference the existing `pauseMutation` and `resumeMutation` definitions in the same file for the exact pattern.

```tsx
const advanceMutation = useApiMutation(
  () => ({ path: `/api/admin/dmarc-promotion/${domainId}/advance`, method: 'POST' }),
  { invalidateKeys: [dmarcPromotionKeys.all], successMessage: 'DMARC policy advanced.' },
);

// in the JSX, alongside Pause/Resume:
{(promotion.dmarc_promotion_state === 'quarantine_ready' ||
  promotion.dmarc_promotion_state === 'reject_ready') && (
  <DestructiveActionDialog
    label="Advance now"
    confirmValue={d.name}
    description="This sends a policy-change command to Cloudflare DMARC Management. The new policy takes effect at the DNS TTL."
    onConfirm={() => advanceMutation.mutate({})}
  />
)}
```

- [ ] **Step 3: Drop the `DmarcPromotionRow.dmarc_record_managed_by_polaris` field from the interface**

In the same file, edit the `DmarcPromotionRow` interface (around line 164) to remove `dmarc_record_managed_by_polaris: number;`.

- [ ] **Step 4: Verify typecheck + dev server starts**

```sh
pnpm --filter @polaris-mail/panel typecheck
pnpm --filter @polaris-mail/panel dev:server &
sleep 5
curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/  # adjust port to whatever dev:server uses
kill %1
```

Expected: typecheck clean; dev server responds. If the panel uses a different port, adapt accordingly. (For CI-style verification, `pnpm --filter @polaris-mail/panel typecheck` is the load-bearing step.)

- [ ] **Step 5: Commit**

```sh
git add apps/panel/src/client/pages/domains/Detail.tsx apps/panel/src/client/queryKeys.ts
git commit -m "feat(panel/domains): replace claim-management with Advance button"
```

---

### Task 16: Docs — rewrite the DMARC reference + operator triage pages

**Files:**
- Modify: `apps/docs/content/security/dkim-dmarc-spf.md`
- Modify: `apps/docs/content/operators/day-2/domain-management.md`
- Modify: `apps/docs/content/operators/troubleshooting/decision-matrix.md`
- Modify: `apps/docs/content/operators/deployment/prerequisites.md` (token-scope section)

- [ ] **Step 1: Rewrite the DMARC section of `dkim-dmarc-spf.md`**

In `apps/docs/content/security/dkim-dmarc-spf.md`, find the "DMARC TXT" subsection (around line 57–75) and replace it with:

```markdown
### DMARC — managed by Cloudflare DMARC Management

polaris-mail no longer publishes its own `_dmarc.<domain>` TXT record.
The Cloudflare DMARC Management product is enabled per-zone during
domain onboarding (`POST /v1/admin/domains` calls
`packages/cf-api/src/dmarc-management.ts:enableDmarcManagement`), and
Cloudflare publishes the `_dmarc` record, ingests aggregate reports
on its side, and surfaces the data via GraphQL Analytics
(`dmarcReportsAdaptive` + `dmarcReportsSourcesAdaptiveGroups`).

polaris-mail mirrors the per-(domain, day) aggregates into
`dmarc_alignment_rollup` nightly (`services/api/src/scheduled/dmarc-mirror.ts`,
cron `0 2 * * *`). The auto-promotion cron at `0 4 * * *` reads the rollup
and walks the same soak state machine as before; when it advances to a
write state, it calls `setDmarcPolicy` on Cloudflare DMARC Management
instead of publishing DNS directly.

Operators can also advance manually via
`POST /v1/admin/dmarc-promotion/:id/advance` (panel "Advance now"
button on the domain detail page). The action requires
`admin:rotate` scope and is wrapped in the type-the-resource-name
confirmation dialog.
```

Also delete the "Out of scope" / "BIMI" lines if they were specific to the deleted RUA-mailbox setup; otherwise leave them.

- [ ] **Step 2: Update the published-records table**

In the same file, the table at the top of "What polaris-mail publishes" listed four records (DKIM CNAME / SPF TXT / DMARC TXT / Bounce MX). Drop the DMARC TXT row. The lead paragraph should now read "three DNS records".

- [ ] **Step 3: Update operator triage**

In `apps/docs/content/operators/troubleshooting/decision-matrix.md`, find any row referencing the ARF-inbox or platform DMARC mailbox and replace the triage step with "Check Cloudflare Dashboard → Email → DMARC Management → [zone]".

In `apps/docs/content/operators/day-2/domain-management.md`, replace any "DMARC report ingestion" sub-section that described the platform RUA mailbox with the CF DMARC Management description above (or link to it).

- [ ] **Step 4: Update token-scope prerequisites**

In `apps/docs/content/operators/deployment/prerequisites.md`, find the Cloudflare API token scope list and confirm `DMARC Management:Edit` and `DMARC Management:Read` are listed. (Operator confirmed 2026-05-23 these scopes are already on the production token.) Add them to the doc if missing.

- [ ] **Step 5: Commit**

```sh
git add apps/docs/content/
git commit -m "docs: rewrite DMARC reference for CF DMARC Management"
```

---

### Task 17: Pre-PR gate

- [ ] **Step 1: Run the full check**

Run: `pnpm check`

Expected: typecheck + lint + fmt:check all pass. Fix any issues inline before proceeding.

- [ ] **Step 2: Run all TS tests**

Run: `pnpm -r test`

Expected: all workspaces green.

- [ ] **Step 3: SQL + OpenAPI validation**

Run:
```sh
pnpm -r run sql:validate 2>/dev/null || true
pnpm -r run openapi:validate 2>/dev/null || true
```

If either is wired in the workspace, expect green. (Per repo memory, both are CI-required jobs.)

- [ ] **Step 4: Generate test vectors (required before go-test)**

Run: `pnpm --filter @polaris-mail/test-vectors run generate`

Expected: vector files refreshed.

- [ ] **Step 5: Go sdk tests**

Run: `cd packages/sdk-go && go test ./... && cd -`

Expected: all pass.

- [ ] **Step 6: Final status check**

Run: `git status --short`

Expected: clean working tree (everything committed in earlier task commits).

---

### Task 18: Deploy

Per repo memory (`feedback_always_redeploy.md`): "Always redeploy after panel/api changes". The mirror cron is registered in `wrangler.jsonc` and will not start firing until the API Worker is redeployed.

- [ ] **Step 1: Deploy changed Workers**

Run: `polaris-mail setup infra deploy changed`

Expected: services/api and apps/panel both redeploy (their code changed). Watch for the new `0 2 * * *` cron showing up in the trigger list and the `enableDmarcManagement` import resolving at build time.

- [ ] **Step 2: Verify cron registered**

Run: `polaris-mail setup infra smoke`

Expected: synthetic + cron-registration checks pass. The smoke output should list `dmarc-mirror` alongside the other crons.

- [ ] **Step 3: Sanity-check a live aggregate fetch**

Manually trigger the mirror cron once via `POST /v1/admin/dmarc-promotion/run` is the existing manual cron trigger; for `dmarc-mirror`, either add an analogous `/run` endpoint OR wait for the first 02:00 UTC cron fire and inspect:

```sh
pnpm --filter @polaris-mail/api exec wrangler d1 execute polaris-mail --remote \
  --command "SELECT domain, day, total_count, dmarc_pass FROM dmarc_alignment_rollup ORDER BY last_seen_at DESC LIMIT 10;"
```

Expected: rows from the last 48h tagged with a fresh `last_seen_at`.

If you want a manual run endpoint, add it (mirror the `dmarc-promotion/run` shape) — but it's optional. The next scheduled run is at most 24h away.

---

## Notes

- **Pre-production stance** (per repo memory `feedback_polaris_preproduction.md`): no feature flags, no shims, no historical-data migration. One PR, clean cut.
- **`pnpm check` is the pre-PR gate** — must be green before deploy.
- **All CI failures matter** (per `feedback_fix_all_ci_failures.md`): if a CI job fails, fix the root cause; do not excuse it as pre-existing.
- **CF endpoint paths** for `enable` / `setPolicy` / `getStatus` and the GraphQL query field names are the most likely production divergence point. If a live call from `services/api` (after deploy) returns 404 / shape-drift, adjust the strings in `packages/cf-api/src/dmarc-management.ts` and `dmarc-graphql.ts` together with their tests, and redeploy.
