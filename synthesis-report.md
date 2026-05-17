# PR 12 Phase E — Synthesis report

Single-agent cross-cutting sweep over `apps/docs/content/` ahead of launch.
Per-page accuracy review (Phase D1) and audience review (Phase D2) are
explicitly out of scope; this pass covers voice, frontmatter, dead-ends,
audience drift, duplication, broken-anchor spot-checks, and the
correctness of the seven `:::warning Out of date:::` admonitions.

Branch: `worktree-agent-a3897b25` · Base SHA: `2371f79b2274e7e0e9f39bd99a2d003bed81b472`

## Build verification

```
$ pnpm --filter @polaris-email/docs run build:client
[SUCCESS] Generated static files in "build".
Pagefind: 124 pages, 5100 words, 0 broken links.
```

`onBrokenLinks: 'throw'` and `onBrokenAnchors: 'throw'` are on in
`docusaurus.config.ts`, so a green build is the broken-link gate. The
only build warnings are the OpenAPI plugin's internal
`@theme/Schema` / `@theme/SchemaTabs` exports — irrelevant to our
content.

## Fixes applied in this pass

### 1. Stub pages replaced (3 pages)

Three audience-overview pages were one-line stubs blocking the
audience-card navigation. Replaced with full index pages that link into
every sub-section:

- `apps/docs/content/developers/overview.md`
- `apps/docs/content/operators/overview.md`
- `apps/docs/content/security/overview.md`

### 2. Reference overview rewritten

`apps/docs/content/reference/overview.md` previously said the CLI and
errors pages would "live at /reference/cli in a later phase" — but
both already exist. Rewrote to point at the live pages. Added missing
`description` + `sidebar_label` frontmatter fields.

### 3. CLI vocabulary page corrected (`reference/cli.md`)

Page documented commands that do not exist in the CLI surface today:

| Wrong                                    | Correct                                         |
| ---------------------------------------- | ----------------------------------------------- |
| `polaris-email credential revoke`        | `polaris-email cred revoke`                     |
| `polaris-email bridge revoke`            | (does not exist — use `rotate` or `deregister`) |
| `polaris-email mailbox disable`          | (REST surface only today)                       |
| `polaris-email mailbox delete --cascade` | (REST surface only today)                       |
| `polaris-email webhook disable`          | (REST surface only today)                       |
| `polaris-email principal delete`         | (REST surface only today)                       |

Rewrote with the verbs that actually compile (`cred revoke`, `bridge
deregister`, `domain disable`, `route disable`, `route enable`, `domain
delete`) and flagged the CLI-parity gap explicitly so the page does
not lie to operators.

### 4. Stale "lands in a later batch" references resolved

Multiple pages cite a future batch for pages that already exist. Fixed
in nine pages:

| Page                                       | Stale claim → fix                                                                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `developers/quickstart.md`                 | `/security/overview` HMAC → `/security/hmac-reference`                                                                                                                                                   |
| `developers/sdks/rest-curl.md`             | `/security/overview` HMAC → `/security/hmac-reference`; `/developers/overview` Messages → `/developers/messages/unified-model`                                                                           |
| `developers/webhooks/lifecycle.md`         | "HMAC spec lands in a later batch" → `/security/hmac-reference`                                                                                                                                          |
| `operators/day-2/cli-tour.md`              | "HMAC reference (lands in a later batch)" → `/security/hmac-reference`                                                                                                                                   |
| `operators/day-2/bridge-management.md`     | "Bridge TLS renewal lands in a later batch" → `/operators/day-2/bridge-tls`                                                                                                                              |
| `operators/day-2/mailbox-management.md`    | "Concepts → Architecture (lands in a later batch)" → `/operators/concepts/architecture`; HMAC link similar                                                                                               |
| `operators/day-2/domain-management.md`     | "domain-onboarding runbook (lands in a later batch)" → DKIM/DMARC/SPF page                                                                                                                               |
| `operators/day-2/credential-management.md` | "credential-rotation / key-rotation runbooks (lands in a later batch)" → `/operators/runbooks/control-plane-rotation`, `/operators/runbooks/anchor-maintenance`, `/operators/runbooks/disaster-recovery` |
| `operators/day-2/routing-and-webhooks.md`  | "HMAC reference (lands in a later batch)" → `/security/hmac-reference`                                                                                                                                   |
| `operators/runbooks/overview.md`           | "cost model (lands in a later batch)" → `/operators/concepts/cost-model`                                                                                                                                 |
| `reference/consumer-contract.md`           | HMAC ref placeholder → `/security/hmac-reference`                                                                                                                                                        |
| `security/threat-model.md`                 | Three references to "lands in later batches" all replaced with live links                                                                                                                                |

### 5. Wrong CLI flags in runbook

`operators/runbooks/data-residency.md` showed
`polaris-email cred list --tenant T` — `--tenant` is the deprecated
alias. Fixed to `--mailbox M` matching the canonical schema.

### 6. Phantom component reference

`developers/sdks/go.md` claimed the Go SDK is used by
"the `polaris-email` CLI, the `mail-bridge` binary, and the
`submission-daemon`". `submission-daemon` does not exist in the repo
today (deferred per the plan's PR 9 wording — "a future
submission-daemon"). Trimmed to the two callers that do exist.

### 7. Redirect table

`apps/docs/src/server/index.ts` REDIRECTS map cleaned up. Several
legacy URLs pointed at runbook MD files that were never created in
this migration (`/runbooks/credential-rotation`,
`/runbooks/dlq-replay`, `/runbooks/domain-onboarding`,
`/runbooks/incident-response`, `/runbooks/key-rotation`,
`/runbooks/killswitch`, `/runbooks/rollback`, `/runbooks/smoke-test`).
Each is now remapped to the closest superset page in the new IA. Added
missing rows for `/api`, `/threat-model`, `/dkim`, `/dmarc`, `/spf`,
`/consumer-contract`, `/security`, `/contributing`, `/linting`, and
the per-runbook canonical paths.

### 8. New `llms.txt`

Created `apps/docs/static/llms.txt` following the emerging
[llmstxt.org](https://llmstxt.org/) convention. One section per
top-level IA category, every canonical page linked. Lets Claude /
similar tools enumerate the site without crawling.

## Admonition correctness check

Seven `:::warning Out of date:::` admonitions checked at HEAD SHA
`2371f79b`. All seven are **still accurate** — the underlying source
files still carry the stale terminology the admonition flags. Detail:

| Page                                        | Flag                                                             | Verified against                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `changelog.md`                              | Two-person `withApproval` retired                                | `apps/panel/README.md` still mentions it; `apps/panel/migrations/0001_drop_step_ups.sql` confirms removal landed                       |
| `changelog.md` (Unreleased section)         | HMAC un-versioned, Python SDK dropped, REVOCATION_DO retired     | Confirmed against current `packages/hmac/src/index.ts`, no `packages/sdk-python/`, no `REVOCATION_DO` Durable Object in `services/api` |
| `operators/day-2/routing-and-webhooks.md`   | CLI does not yet expose a `webhook subs` verb                    | `apps/polaris-cli/internal/cmds/webhook.go` confirms — only `webhook dlq` subcommands                                                  |
| `operators/day-2/mailbox-management.md`     | CLI does not yet expose a `mailbox` verb                         | No `mailbox.go` in `apps/polaris-cli/internal/cmds/`                                                                                   |
| `operators/runbooks/overview.md`            | Two-person rule on DLQ drops is now type-the-id, not co-sign     | Code confirms; admonition is correct                                                                                                   |
| `operators/deployment/cloudflare-access.md` | `apps/panel/README.md` still describes `withApproval`            | Verified — README still has it, code does not                                                                                          |
| `security/threat-model.md`                  | Anchor rotation step still cites `withApproval('anchor.rotate')` | Same — copy needs an eventual cleanup pass, but the warning is accurate                                                                |

No admonition was removed or rewritten — all are accurate. Each
flags a known stale paragraph that the writers preferred to leave in
place (with a visible warning) rather than rewrite at the same time
as migration.

## Findings deferred to Phase D1 / D2

### `<!-- TODO(d2): ... -->` markers added

Not added in this pass — every fix in this sweep was an obvious
correction (broken link, missing frontmatter, wrong CLI flag, stale
"in a later batch" pointer to a page that exists). The judgment-call
findings below are captured in this report only.

### Audience drift to fix in Phase D2

The operator section has more `services/api/src/...` paths than the
audience boundary really wants. Operators reading the runbooks
shouldn't need to open the repo to act. The pages below each carry
one or more internal paths an operator should not need:

- `operators/day-2/monitoring.md` — `services/api/src/scheduled/synthetic.ts`,
  `services/api/src/scheduled/staleness.ts`,
  `services/api/src/lib/admin-alert.ts`,
  `services/api/src/queue/ssrf.ts`,
  `services/api/src/env.ts`.
- `operators/runbooks/cf-account-compromise.md` — `services/api/src/scheduled/anchor.ts`,
  `packages/object-lock`.
- `operators/runbooks/anchor-maintenance.md` — `services/api/src/scheduled/anchor.ts`.
- `operators/runbooks/retention-and-cleanup.md` — `services/api/src/scheduled/janitor.ts`.
- `security/threat-model.md` — `services/api/src/scheduled/audit-verify.ts`,
  `apps/panel/src/components/SecretRevealDialog.tsx`,
  `apps/panel/src/server/auth/role-sync.ts`.
- `operators/day-2/routing-and-webhooks.md` — `services/api/src/queue/fanout.ts`.
- `security/dkim-dmarc-spf.md` — operator triage table sits next to
  contributor-facing source paths (`services/api/src/routes/admin/...`).

The contributor-facing `contributing/architecture-deep-dive.md`
deliberately keeps all of these — that's correct for that audience.
The Phase D2 work should decide page-by-page whether to move the
operator-facing paragraph into the contributor section, or to keep
the path inline but reframe it as a where-to-look hint for the
operator who needs it.

### CLI commands referenced that do not exist

Caught in this pass but only partially fixed (the bigger rewrites are
D1's job):

- `operators/day-2/routing-and-webhooks.md` — `polaris-email webhook subs ...` (CLI has only `webhook dlq`).
- `operators/day-2/mailbox-management.md` — `polaris-email mailbox ...` (admin REST only).
- `operators/day-2/credential-management.md` — `--tenant` deprecated alias still surfaced under deprecation notice (correct).
- `operators/runbooks/webhook-dlq.md` — `polaris-email webhook-sub pause <id>` (does not exist; admin REST only).
- `operators/runbooks/overview.md` — same.
- `security/dkim-dmarc-spf.md` — `polaris-email domain enable-mta-sts`, `polaris-email domain enable-tls-rpt` (admin REST endpoints only — no CLI verb today).

Each of these is flagged in the page's text with the right
"admin REST surface today / CLI parity is follow-up" caveat, so the
reader is not misled, but the per-page rewrite for Phase D1 should
prune the phantom commands.

### Page-level rewrites recommended for D1

- `operators/day-2/cli-tour.md` — the verb list is exhaustive enough
  that it overlaps `reference/cli.md`. Decide whether one is the
  tour and the other the reference, or merge.
- `developers/authentication/concept.md` — uses `/v1/send/raw` in the
  worked example. The path was retired (per changelog) in favour of
  `/v1/messages`. The test-vector file still has the old path, so
  the example is internally consistent, but a reader following the
  example against a live deployment would 404. D1 should either
  regenerate the test vector or call out the historical-fixture
  framing explicitly.
- `security/hmac-reference.md` — same `/v1/send/raw` issue.
- `developers/messages/unified-model.md` — `INLINE_BODY_BYTES_MAX` /
  `INLINE_ATTACHMENTS_BYTES_MAX` env var names — confirm against
  `services/api/src/env.ts`. The naming in this doc is consistent
  with itself but may have drifted from the code.
- `developers/sdks/node.md` and `developers/sdks/go.md` — both
  reference the SDK as "internal-only, not published to npm / Go
  public proxy". That framing is accurate today but might bite an
  external reader. Decide.
- `operators/deployment/cold-start-bootstrap.md` — the "two paths
  during the soak window" framing was a transition-era device. Once
  PR 7 lands (genesis-seal + happy-path runner) the shell flow is
  gone. Re-evaluate once PR 7 lands.
- `developers/webhooks/lifecycle.md` — the events list is correct
  but the SDK verifier "secret_prev" support is something a real
  reader needs to verify against the SDK source. D1 reviewer should
  confirm.

### Duplication observed (D2 fan-out should resolve)

The mailbox-centric schema is explained in four places at varying
depth:

- `developers/messages/unified-model.md` (developer surface).
- `operators/concepts/architecture.md` (operator surface).
- `operators/day-2/mailbox-management.md` (workflow page).
- `contributing/architecture-deep-dive.md` (contributor surface).

All four are internally consistent and audience-appropriate. None of
them contradicts another. D2 should confirm the four-layer pattern is
the right call rather than over-trim — different audiences need
different levels of detail.

The on-call runbook (`operators/runbooks/overview.md`) and the
troubleshooting decision matrix
(`operators/troubleshooting/decision-matrix.md`) cover overlapping
ground. The decision-matrix page explicitly frames itself as the
index and the runbook as the deep-dive; that distinction is correct
but the writers should ensure neither one introduces a new fact the
other doesn't carry.

### Voice and frontmatter

Every page now has `title`, `description`, `sidebar_label`,
`sidebar_position` after this pass. (Before: the four overview stubs
were missing `description` and `sidebar_label`.) Voice is consistent
— second-person, terse, decision-tables-over-prose, no emojis, no
exclamation marks. The stubs were the only voice outliers.

## Sidebar sanity check

`apps/docs/sidebars.ts` uses `autogenerated`, so categories are read
from each `_category_.json`. Every category has matching metadata.
Position numbers do not collide across the top level:

| Top-level               | Position |
| ----------------------- | -------- |
| Get started             | 1        |
| For developers          | 2        |
| For operators           | 3        |
| For security reviewers  | 4        |
| Reference               | 5        |
| Contributing            | 6        |
| Changelog (single page) | 7        |

Within `operators`, position numbers are 1 (overview), 2 (concepts /
runbooks), 3 (deployment), 4 (day-2), 5 (troubleshooting). The "1
overview + 2 concepts + 2 runbooks" tie at position 2 between
`Concepts` and `Runbooks` is harmless — both render as collapsed
categories under "For operators". No orphan pages.

## llms.txt + redirects deliverables

| Deliverable                                  | Path                                                                      | Status    |
| -------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| llms.txt                                     | `apps/docs/static/llms.txt`                                               | created   |
| REDIRECTS table cleanup                      | `apps/docs/src/server/index.ts`                                           | updated   |
| Stub overview pages                          | `apps/docs/content/{developers,operators,security,reference}/overview.md` | rewritten |
| CLI vocabulary page                          | `apps/docs/content/reference/cli.md`                                      | rewritten |
| "Lands in a later batch" pointers            | 13 pages                                                                  | fixed     |
| `--tenant` deprecated flag in data-residency | `apps/docs/content/operators/runbooks/data-residency.md`                  | fixed     |
| Phantom submission-daemon reference          | `apps/docs/content/developers/sdks/go.md`                                 | fixed     |

## Final build

```
[SUCCESS] Generated static files in "build".
124 pages, 5100 words indexed by Pagefind, 0 broken links.
```

## What's left for Phase D1 / D2

The judgment-call items above (audience drift, phantom CLI verbs in
operator pages, the four-place mailbox-schema duplication, the
historical `/v1/send/raw` examples) are explicitly out of scope for
the synthesis sweep. They are captured here so the fan-out reviewers
have a starting list rather than a blank page.
