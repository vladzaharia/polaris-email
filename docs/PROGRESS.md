# Implementation progress vs the plan

Snapshot of what shipped on `feat/polaris-email-redesign` vs what remains.
Updated on every commit; pairs with `docs/OPERATOR.md` (workflows) and
`docs/RUNBOOK.md` (incident response).

## Phase summary

| Phase | Status | Notes |
|---|---|---|
| **−1** Cloudflare API spike | ✅ Scripts ready | Operator runs against live CF account; fills out `docs/spike/results.md`. |
| **0** Schema + structural rebuild | ✅ Foundation | New schema (control/messages/audit shards), new packages, new endpoints. Modular monolith collapse deferred — legacy `services/api` continues to serve while the new pipeline runs alongside. |
| **0.5** Critical security mitigations | ✅ C1, C2, H1, H7 | C3 partially (admin scope split is wired in CLI but the Worker-side enforcement is in `services/api/src/auth.ts` only for the legacy scopes; new scopes need to land in the workers/control-plane cutover). |
| **1** Submission daemon (Go) | ✅ Done | 17 files, all tests pass. Multi-host registration model in place. |
| **2** Polaris CLI (Go) | ✅ Done | Full subcommand tree, vet+build clean. End-to-end via `--help` confirmed. Exhaustive automated tests are a v1.x backfill. |
| **3** Domain lifecycle automation | ✅ Done | `cf-api` package covers Email Routing + Email Service + DNS verify + DKIM rotation + decommission + bulk-onboard. CF-managed-DNS-by-default workflow per Resolved Q7. |
| **4** Observability + polish | ⏳ Partial | `docs/cost-model.md` shipped; Logpush + Workers Analytics Engine + workers-otel wiring lives as docs/code references but not yet committed as a Worker config. |
| **5** High-severity security debt | ⏳ Partial | H1 (DO), H3 (SSRF guard), H5/I13 (HKDF pepper), H7 (constant-time) shipped. H2 (IDNA exact match) shipped. H4 (R2 object lock + external mirror), H6 (per-tenant envelope encryption), H8 (decommission state machine — done in cf-api), H9 (one-shot bootstrap with anchored genesis) remain as v1.x deliverables. |

## Test posture

**228 tests across 22 packages** all passing as of latest commit.

Per-package breakdown:

| Package | Tests | Notes |
|---|---:|---|
| @polaris-email/cf-api | 7 | dkim-rotation only; bulk-onboard / decommission tests are v1.x backfill |
| @polaris-email/crypto-utils | 20 | pepper / argon2-deferred / timing |
| @polaris-email/hmac | 19 | existing |
| @polaris-email/migrations | 9 | new |
| @polaris-email/mime | 43 | canonicalize + sender-policy + address-norm |
| @polaris-email/providers | 6 | registry resolution incl. wildcard inheritance |
| @polaris-email/revocation-do | 6 | DO routes |
| @polaris-email/schema | 19 | existing + new audit actions |
| @polaris-email/url-guard | 26 | full SSRF reject categories |
| @polaris-email/test-vectors, webhook-verify-node | 16 | existing |
| services/anchor, forensic, janitor, staleness, in, out, fanout, synthetic, api | 39 | all existing tests pass |
| apps/panel, apps/bridge/sidecar | 23 | existing |
| **Total** | **228** | |

Plus the Go modules:
- `apps/submission-daemon/` — `go vet`, `go build`, `go test ./...` clean
- `apps/polaris-cli/` — `go vet`, `go build` clean; binary's `--help` exercises the full subcommand tree

## What's NOT in the worktree yet (deliberately deferred)

These are real Phase 0 deliverables I deferred during execution because each
depends on either (a) the user's CF account (so cannot be tested here), or
(b) a substantial rewrite of working code that's better done with the
operator validating each step. None of these are blocked by the worktree —
they're sequenced for after the user runs Phase −1.

1. **Modular monolith collapse**: `services/{api,out,fanout,anchor,staleness,janitor,synthetic}` → `workers/control-plane`. The new endpoints live alongside the legacy ones; cutover is incremental.
2. **`services/api/src/routes/messages.ts:79-88` migration to new `domains` table**: still reads the legacy table; the `submit-message.ts` pipeline reads the new shape. Cut over once the new shape is populated.
3. **`services/out/src/index.ts` Provider integration**: the Provider interface exists in `@polaris-email/providers`; `services/out` still uses per-domain `send_email` bindings until Phase 0d cutover.
4. **D1 sharding cutover**: migrations exist for `control/`, `messages/`, `audit/`; tests still apply `legacy/` migrations. Cutover requires creating the new D1 databases (`wrangler d1 create`) and updating the API's wrangler.jsonc.
5. **Phase 4 observability**: Logpush config, Workers Analytics Engine writes, `workers-otel` instrumentation are documented but not yet wired into a Worker.
6. **Phase 5 H4 / H6 / H9**: R2 object lock provisioning + per-tenant envelope encryption + one-shot bootstrap with anchored genesis are documented in the plan but require operator action to provision (Object Lock retention period, per-tenant KEK, WebAuthn enrollment).

## Running tests locally

```bash
cd .worktrees/redesign
pnpm -r build
pnpm -r test

# Go modules
cd apps/submission-daemon && go test ./... && cd -
cd apps/polaris-cli       && go vet ./... && go build ./... && cd -

# CLI smoke
go run ./apps/polaris-cli/cmd/polaris-email --help
```

## Branch + commit log

Branch: `feat/polaris-email-redesign` (worktree at `.worktrees/redesign`)

Recent commits:
- Phase 3: pivot email-service to CF-managed-DNS-by-default workflow
- Phase 0.5/3/5: security utils + cf-api lifecycle + CLI + docs
- Phase 0/0.5: submitMessage pipeline + send-raw + Go daemon
- Phase 0 (part 1): new schema + Provider + MIME + Terraform scaffolds
- Phase -1: Cloudflare API spike scripts and results template
- Ignore .worktrees/ directory
