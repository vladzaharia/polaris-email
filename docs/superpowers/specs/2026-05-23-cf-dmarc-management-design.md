# Cloudflare DMARC Management — design

**Status:** approved (brainstorm 2026-05-23) — pending implementation plan
**Owners:** Vlad
**Replaces:** the platform-RUA ARF-inbox ingest stack (`services/in/src/dmarc-ingest.ts` + `packages/dmarc-parser` + `dmarc_aggregate_reports` table + platform-DMARC mailbox)

## 1. Motivation

polaris-mail currently runs its own DMARC aggregate-report pipeline:

- Every onboarded domain gets `mailto:dmarc-rua@plrs.im` injected into its `_dmarc` TXT (`services/api/src/routes/admin/domains.ts:180`).
- Inbound mail to that platform mailbox lands in `services/in/src/dmarc-ingest.ts`, which walks the MIME body, gunzips the XML payload, calls `packages/dmarc-parser`, and writes one row per report into `dmarc_aggregate_reports` plus a per-(domain, day) rollup into `dmarc_alignment_rollup`.
- A nightly cron (`services/api/src/scheduled/dmarc-promote.ts`) reads the rollup, walks a soak-based state machine (`none → quarantine_ready → quarantine → reject_ready → reject`), and is structurally ready to publish DNS changes via `packages/cf-api` (the `publishDmarcRecord` hook is currently a no-op).

Cloudflare's per-zone DMARC Management product subsumes the entire ingest path: it appends its own `rua=` tag to the zone's `_dmarc` TXT when enabled, ingests aggregate reports on Cloudflare's side, and exposes the data via GraphQL Analytics (`dmarcReportsAdaptive` + `dmarcReportsSourcesAdaptiveGroups`). Operator clarification (2026-05-23): polaris-mail should treat Cloudflare as the system of record for DMARC — read-only by default, with an opt-in command path back into CF to enable/disable the feature and to advance policy.

## 2. Goals and non-goals

**Goals**

- Delete the ARF-inbox + custom MIME walker + XML parser. CF is the only DMARC report ingest path.
- Stop emitting our own `_dmarc` TXT. Cloudflare DMARC Management owns the record.
- Mirror per-(domain, day) aggregates from CF GraphQL into the existing `dmarc_alignment_rollup` table on a daily cadence, so the existing promotion cron and panel summary endpoints keep working without refactoring.
- Auto-enable DMARC Management during domain onboarding (`POST /v1/admin/domains`) via a new `packages/cf-api` helper.
- Keep the soak-based state machine as a recommendation engine. Wire the "advance" action (auto-mode cron and a new opt-in operator-initiated route) to call a CF policy-change endpoint instead of touching DNS directly.

**Non-goals**

- Backward compatibility with operators whose zones are outside Cloudflare DNS. Per the pre-production stance, polaris-mail's outbound domains live in CF zones; the existing `cfManagedDns: false` fallback in `packages/cf-api/src/email-service.ts` is being retired for DMARC. (Manual-publish DNS for DKIM/SPF/bounce-MX is unaffected.)
- Migrating historical rows out of `dmarc_aggregate_reports`. The table is dropped; existing rollup rows in `dmarc_alignment_rollup` survive untouched.
- BIMI. Still out of scope.
- A new MTA-STS-style operator opt-in for DMARC Management. Enablement is automatic during domain onboarding; the MTA-STS analogy doesn't apply because DMARC Management is a single idempotent API call with no Worker provisioning.

## 3. Architecture

```
                 ┌───────────────────────────────────────────┐
                 │  Cloudflare (owns _dmarc TXT + RUA + data)│
                 │                                           │
                 │   DMARC Management (per-zone, enabled     │
                 │     during polaris domain onboarding)     │
                 │                                           │
                 │   GraphQL Analytics:                      │
                 │     dmarcReportsAdaptive                  │
                 │     dmarcReportsSourcesAdaptiveGroups     │
                 └─────▲──────────────────────────▲──────────┘
                       │ enable / change policy   │ GraphQL pulls
                       │ (REST, opt-in only)      │
       ┌───────────────┼──────────────────────────┼─────────────┐
       │ services/api  │                          │             │
       │ ┌─────────────┴────────┐   ┌─────────────┴──────────┐  │
       │ │ onboarding (existing)│   │ dmarc-mirror cron (new)│  │
       │ │  + enable DMARC mgmt │   │  daily, writes rollup  │  │
       │ └──────────────────────┘   └────────────┬───────────┘  │
       │                                         │              │
       │ ┌──────────────────────┐   ┌────────────▼───────────┐  │
       │ │ promotion cron       │◄──┤ dmarc_alignment_rollup │  │
       │ │ (existing; write path│   │ (D1, unchanged shape)  │  │
       │ │  rewired → CF API)   │   └────────────┬───────────┘  │
       │ └──────────┬───────────┘                │              │
       │            │                            │              │
       │ ┌──────────▼────────────────────────────▼───────────┐  │
       │ │ admin REST:                                       │  │
       │ │   GET  /dmarc-reports*       ← live GraphQL       │  │
       │ │   GET  /dmarc-reports/summary ← D1 rollup         │  │
       │ │   POST /dmarc-promotion/:d/advance (new, opt-in)  │  │
       │ │   POST /dmarc-promotion/:d/{pause,resume}         │  │
       │ └───────────────────────────────────────────────────┘  │
       └────────────────────────────────────────────────────────┘
```

Two new code paths (CF GraphQL client + DMARC Management REST helpers), one new cron, one new REST route. Several deletions.

### Architectural decisions (and the alternatives considered)

| Decision                    | Chosen                                                                       | Alternatives                                                                        | Why                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Where reports live          | Mirror per-(domain, day) into D1                                             | Query CF GraphQL on every panel request; hybrid (rollup mirror + live detail)       | Promotion cron is the load-bearing reader and must not depend on a live external API. Panel detail view tolerates live GraphQL fine. |
| Per-source-IP detail        | Live CF GraphQL on the detail route                                          | Mirror to a new `dmarc_report_sources` table                                        | Detail view is operator-curiosity; not worth doubling the schema.                                                                    |
| Non-CF-DNS operators        | Drop the path. polaris-managed outbound domains require a CF zone for DMARC. | Keep ARF inbox as a documented fallback; CF-DNS-only with a stubbed promotion state | Pre-production; cleaner cut over gradual cutover.                                                                                    |
| DMARC Management enablement | Auto during `POST /v1/admin/domains`                                         | Operator-initiated CLI/panel step (mirror MTA-STS)                                  | DMARC Management is one idempotent API call. MTA-STS analogy doesn't apply (no Worker provisioning).                                 |
| Polaris and DMARC policy    | Recommendation + opt-in command path                                         | Pure read-only; recommendation-only without command path                            | Keeps the value of the existing soak state machine; "at best, issue commands" interpretation.                                        |
| Policy-change mechanism     | Call into CF (Email Service or DMARC Management endpoint)                    | Direct `_dmarc` TXT edit via DNS API                                                | "Let CF manage the records entirely." Polaris does not own the record.                                                               |

## 4. Component-level changes

### 4.1 New

- **`packages/cf-api/src/dmarc-management.ts`** — REST helpers:
  - `enableDmarcManagement(client, zoneId)` — idempotent; tolerates "already enabled" without erroring.
  - `getDmarcManagementStatus(client, zoneId)` — read for the verify path / panel.
  - `setDmarcPolicy(client, zoneId, domain, policy)` — the opt-in command path. `policy ∈ {'none','quarantine','reject'}`. **Exact CF endpoint TBD during implementation (see §9 Research items).**
- **`packages/cf-api/src/graphql.ts`** — minimal GraphQL POST client. cf-api today is REST-only; this is its first GraphQL surface. Wraps `https://api.cloudflare.com/client/v4/graphql` with the existing token auth.
- **`packages/cf-api/src/dmarc-graphql.ts`** — typed query for `dmarcReportsAdaptive` aggregated `by: [date, domain]`, parameterized by `zoneTag` and `date_geq` / `date_leq`. Returns a `{ domain, day, totalCount, dmarcPass, dkimPass, spfPass }` shape that maps 1:1 onto the existing `dmarc_alignment_rollup` columns.
- **`services/api/src/scheduled/dmarc-mirror.ts`** — daily cron. Walks `mail_domains` joined to `cf_zones`, queries CF GraphQL per zone, upserts `dmarc_alignment_rollup` rows for a 2-day rolling window (absorbs CF late-arriving aggregation). On GraphQL failure: log + emit `dmarc_mirror_failure` admin alert; skip that zone; continue.
- **Admin REST**: `POST /v1/admin/dmarc-promotion/:id/advance` (new). Computes the next state from current rollup, calls `setDmarcPolicy`, transitions `dmarc_promotion_state`, audit-logs `dmarc.promote`. Gated on `admin:rotate` scope.
- **Migration**: `services/api/migrations/0005_cf_dmarc_management.sql`:
  - `DROP TABLE dmarc_aggregate_reports;`
  - `ALTER TABLE mail_domains DROP COLUMN dmarc_rua;`
  - `ALTER TABLE mail_domains DROP COLUMN dmarc_record_managed_by_polaris;`
  - `DELETE FROM mailboxes WHERE id = '01HXPLATFORMDMARCREPORTS00';`
- **Wrangler**: add the daily-mirror cron to `services/api/wrangler.jsonc`'s `triggers.crons`. Suggested slot: `0 2 * * *` (02:00 UTC, two hours before the existing dmarc-promote at 04:00, so the rollup is fresh when the promotion cron reads it).

### 4.2 Modified

- **`packages/cf-api/src/email-service.ts`**
  - `expectedRecordsFor()` — drop the `_dmarc` TXT entry (lines 257–262).
  - `verifyOnboarding()` / `checkSenderOnboardedViaCf()` — drop any `_dmarc` checks (already absent from the latter; double-check the former).
  - `onboardSenderDomain()` — after a successful Email Service onboard, call `enableDmarcManagement(client, zoneId)`. Failure here records a `dmarc_mgmt_provisioning_hint` on the returned `OnboardResult` but does not fail the onboard.
- **`services/api/src/routes/admin/domains.ts:180`** — delete the `platformDmarcRua` injection. Honour `body.dmarc_rua` only if explicitly supplied; otherwise omit the column entirely (it's dropped in 4.1).
- **`services/api/src/scheduled/dmarc-promote.ts`**
  - `publishDmarcRecord()` becomes a real call to `setDmarcPolicy`. Drop the `dmarc_record_managed_by_polaris === 1` guard (CF always manages).
  - The `dmarc.claim_management` audit action and the corresponding state are no longer reachable; remove from the action list.
- **`services/api/src/scheduled/index.ts`** — register `dmarc-mirror` for the new cron expression.
- **`services/api/src/routes/admin/dmarc-reports.ts`**
  - `GET /v1/admin/dmarc-reports` → live CF GraphQL (paginated by date window; default last 7 days).
  - `GET /v1/admin/dmarc-reports/:id` → live CF GraphQL detail lookup (`dmarcReportsSourcesAdaptiveGroups` filtered to that report's source).
  - `GET /v1/admin/dmarc-reports/summary` → unchanged (reads `dmarc_alignment_rollup`).
- **`services/api/src/routes/admin/dmarc-promotion.ts`**
  - Drop `POST /:id/claim-management` + the `dmarc.claim_management` audit action.
  - Add `POST /:id/advance`.
- **`services/in/src/index.ts:233`** — delete the `PLATFORM_DMARC_REPORTS_MAILBOX_ID` dispatch branch and the import.
- **`services/api/src/env.ts:63`** — drop `DMARC_RUA_PLATFORM_ALIAS`.
- **`apps/panel/src/client/pages/domains/Detail.tsx`**
  - Drop the "claim DNS management" button + mutation (around line 975).
  - Drop the `dmarc_record_managed_by_polaris` badge.
  - Add an "Advance now" button on the promotion card, enabled when `dmarc_promotion_state` is `quarantine_ready` or `reject_ready`. Wraps it in `DestructiveActionDialog` (the existing type-the-resource-name confirmation).
- **`apps/panel/src/client/queryKeys.ts`** — adjust keys to reflect the new REST shape.
- **`apps/docs/content/security/dkim-dmarc-spf.md`** — rewrite the DMARC section. The published-records table loses the `_dmarc` row; add a paragraph explaining that CF DMARC Management owns the record and is auto-enabled at onboarding.
- **`apps/docs/content/operators/day-2/domain-management.md`** + **`troubleshooting/decision-matrix.md`** — replace ARF-inbox triage steps with "check Cloudflare dashboard → Email Security → DMARC Management → [zone]".

### 4.3 Deleted

- `services/in/src/dmarc-ingest.ts`
- `services/in/test/integration/dmarc-ingest.workers.test.ts`
- `packages/dmarc-parser/` (entire package, plus its `pnpm-workspace.yaml` entry)
- `dmarc_aggregate_reports` D1 table
- Platform DMARC mailbox row (`01HXPLATFORMDMARCREPORTS00`) and its `principal` / `mailbox_senders` if any
- `DMARC_RUA_PLATFORM_ALIAS` env var (services/api, wrangler configs, docs)
- `dmarc.claim_management` audit action — dropped from the CHECK constraint in the same migration (no legacy concepts retained per the operator directive 2026-05-23)

## 5. Data flow

### 5.1 Onboarding (synchronous)

```
POST /v1/admin/domains { name, ... }
  → packages/cf-api: onboardSenderDomain (existing)
        publishes DKIM CNAME, SPF TXT, cf-bounce MX (no _dmarc)
  → packages/cf-api: enableDmarcManagement(zoneId) (new)
        CF appends its own rua= tag to whatever _dmarc TXT exists,
        or prompts at the dashboard if none does
  → insert mail_domains row (no dmarc_rua, no dmarc_record_managed_by_polaris)
  → audit: domain.create, dmarc.mgmt_enabled (new sub-action)
  → respond 201 with provisioning_hint if dmarc enable failed
```

### 5.2 Daily mirror (asynchronous, cron `0 2 * * *`)

```
For each mail_domains row WHERE status='verified' AND capabilities_outbound=1:
  Resolve the CF zone via mail_domains.cf_zone_id (or its registered parent via the zones table).
  GraphQL POST /client/v4/graphql:
    dmarcReportsAdaptive(
      filter: {zoneTag: ..., date_geq: today-2, date_leq: today}
      orderBy: [date_ASC]
      limit: 10000
    ) {
      dimensions { date, headerFrom }
      sum { totalCount, dmarcPass, dkimPass, spfPass }
    }
  For each row, upsert dmarc_alignment_rollup
    ON CONFLICT(domain, day) DO UPDATE.
  On failure: log + sendAlert('dmarc_mirror_failure', severity='warn').
```

### 5.3 Promotion (asynchronous + synchronous)

- **Auto cron (existing, 04:00 UTC)** — unchanged inputs (`dmarc_alignment_rollup`). On `mode='auto'` advancement to a write state, the existing `publishDmarcRecord` stub is replaced with a `setDmarcPolicy` call. Audit row records `dns_published` based on whether CF returned 2xx.
- **Operator-initiated** — `POST /v1/admin/dmarc-promotion/:id/advance` computes the next state from the current rollup window (same predicates as the cron), calls `setDmarcPolicy`, transitions state, audit-logs. Returns 409 if the soak predicates fail.

### 5.4 Panel reads

- Reports list/detail: panel → `services/api` REST → cf-api GraphQL → CF. No D1 read on the hot path. Cached client-side by `@tanstack/react-query` with a 5-minute stale window.
- Summary card: panel → `services/api` REST → D1 (`dmarc_alignment_rollup`). Same shape as today.

## 6. Schema migration

**Migration `0005_cf_dmarc_management.sql`** (rough sketch):

```sql
DROP TABLE IF EXISTS dmarc_aggregate_reports;

-- D1 supports ALTER TABLE DROP COLUMN.
ALTER TABLE mail_domains DROP COLUMN dmarc_rua;
ALTER TABLE mail_domains DROP COLUMN dmarc_record_managed_by_polaris;

-- Platform mailbox + its principal + sender rows.
DELETE FROM mailbox_senders   WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM mailbox_receivers WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM principals        WHERE mailbox_id = '01HXPLATFORMDMARCREPORTS00';
DELETE FROM mailboxes         WHERE id          = '01HXPLATFORMDMARCREPORTS00';
```

`dmarc_alignment_rollup` schema unchanged. Existing rows survive — they are still valid aggregates regardless of source.

Audit-action CHECK constraints in 0001_init.sql / 0004_admin_alerts_dismissal.sql still mention `dmarc.claim_management`. **Rebuild the relevant table(s) in this migration to drop that value from the allow-list.** D1/SQLite does not support `ALTER TABLE ... DROP CONSTRAINT`, so the rebuild is the only path. No legacy concepts retained per the operator directive.

## 7. Error handling

| Failure                                                    | Behaviour                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enableDmarcManagement` errors during onboarding           | Log + record `dmarc_mgmt_provisioning_hint` on response; do not fail onboard. Operator can retry via a new `polaris-mail domain enable-dmarc-mgmt <domain>` CLI command (added to `apps/polaris-cli`). |
| CF GraphQL request fails during mirror cron                | Log; emit `dmarc_mirror_failure` admin alert (severity `warn`); skip the zone; continue. Rollup stays at last-mirrored values.                                                                         |
| CF GraphQL returns shape we don't recognize                | Type-check at parse boundary; skip the row; log a structured `dmarc_mirror_shape_drift` warning. Do not write malformed data.                                                                          |
| `setDmarcPolicy` fails (auto cron)                         | Do not advance `dmarc_promotion_state`. Audit-log with `dns_published=false`. Emit `dmarc_policy_publish_failed` admin alert. Next cron run retries.                                                   |
| `setDmarcPolicy` fails (operator `/advance`)               | Return 502 with the CF error body; state is unchanged.                                                                                                                                                 |
| Zone not found / `mail_domains.cf_zone_id` is NULL         | Skip the domain in the mirror cron; surface a `dmarc_mirror_zone_missing` warning. The panel summary card shows "no data yet".                                                                         |
| 14-day rolling window is sparse (new domain or low volume) | State machine already requires `daysCovered >= 14` and `dailyAvg >= 100`; stays in `none` until the window fills. No change.                                                                           |

## 8. Testing strategy

- **`packages/cf-api`**
  - Unit: `dmarc-management.test.ts` — mock fetch; assert request shape and idempotency on "already enabled" responses.
  - Unit: `dmarc-graphql.test.ts` — mock fetch; assert query body and the rollup-row mapping.
- **`services/api`**
  - Integration: `test/integration/dmarc-mirror.workers.test.ts` (new) — stubs CF GraphQL via miniflare's `fetchMock`; runs the cron; asserts `dmarc_alignment_rollup` upserts.
  - Integration: `test/integration/dmarc-promote.workers.test.ts` (rewire) — pre-populate rollup, assert state-machine transitions and that `setDmarcPolicy` is called on `mode='auto'`. Drop ARF-inbox fixtures.
  - Integration: `test/integration/dmarc-promote-advance.workers.test.ts` (new) — exercise the operator `POST /:id/advance` route, including the 409 path when soak predicates fail.
- **Schema**
  - `packages/schema/test/schema.test.ts` — update to drop `dmarc_aggregate_reports` references and the deleted columns.
- **Deleted tests**
  - `services/in/test/integration/dmarc-ingest.workers.test.ts`
  - `packages/dmarc-parser/test/parse.test.ts`
- **Panel** — keep existing tests for the promotion card; update the "claim management" assertion to assert the button is gone and the "Advance now" button exists.

## 9. Research items (resolve during implementation, not now)

- **R-1: Exact CF DMARC Management enable endpoint.** Likely `POST /zones/{zone_id}/dmarc_management/...` or under `/zones/{zone_id}/email/security/...`. Confirm by API probe + the live CF docs at the time of implementation.
- **R-2: Exact CF policy-change endpoint.** Could be Email Service (`/accounts/{account_id}/email-service/sender-domains/{domain}` PATCH), DMARC Management (`/zones/{zone_id}/dmarc_management/...`), or the bare DNS API. The first two preserve "CF manages the record"; the third does not. Strong preference for the first available.
- **R-3: GraphQL filter syntax.** Confirm whether `dmarcReportsAdaptive` accepts `headerFrom` as a dimension filter, or whether per-zone queries already pre-filter the data. (Affects whether we issue one query per zone or one query per account.)
- **R-4: Region selection.** US vs EU GraphQL endpoints. Likely follow the zone's data localization setting; check whether `cf_zones` already carries that signal.

These do not affect the architecture, only the function-body details of `packages/cf-api/src/dmarc-management.ts` and `dmarc-graphql.ts`.

## 10. Resolved questions

- **Audit-action CHECK constraint** — drop `dmarc.claim_management` from the allow-list in the same migration (table-rebuild approach). No legacy concepts retained.
- **Operator override on policy advancement** — not in v1. Emergencies route through the Cloudflare dashboard. Re-evaluate post-launch only if it actually comes up.

## 11. Out of scope

- Pre-production cutover. One PR, no shims, no staged rollout, no historical-data migration.
- Surfacing `dmarcReportsSourcesAdaptiveGroups` as a top-level panel view (e.g., "top spoofing source IPs across the fleet"). Worth doing later; not part of this design.
- BIMI publication.
- Changes to DKIM, SPF, or MTA-STS handling. Email Service onboarding still owns DKIM/SPF/bounce-MX; MTA-STS is unrelated.
