# Phase −1 spike results

> Fill in after running each script in `scripts/spike/`. Phase 0 is gated on
> these answers.

## Spike 1 — `EMAIL` binding model

- [ ] Account-level (parameterized by `from`) — **expected**, design proceeds as planned.
- [ ] Per-domain (one binding per onboarded zone) — **redesign required**: the per-Worker binding-count cap (~64) kills the design at ~30 onboarded domains. See I9.

Conclusion: ___

## Spike 2 — Email Routing + Service coexistence

- MX records observed: ___
- Coexistence works without conflict: ___

## Spike 3 — Wildcard DKIM CNAME + wildcard Email Routing rule

- Wildcard DKIM CNAME (`*._domainkey.<zone>`) signs subdomains: ___
- Wildcard Email Routing rule (`*@*.<zone>`) catches subdomains: ___

If wildcard rule rejected, fall back to per-subdomain rules and document the
200-rule-per-zone pressure (I8).

**Note (clarification 2026-05)**: Cloudflare auto-publishes the DKIM, SPF,
and bounce-MX records when Email Service onboarding is enabled on a zone.
This spike is therefore primarily about *verifying* that the records CF
publishes for a subdomain (e.g., `mail.acme.com`) sign mail correctly via
the wildcard CNAME structure when the parent zone is `acme.com`. Our code
DoH-verifies; we don't normally write DNS records ourselves.

## Spike 4 — `cf-bounce` MX semantics

- Hard bounce delivery format: ___
- Soft bounce delivery format: ___
- Complaint/FBL delivery format: ___
- Latency: ___
- Correlation header(s): ___

## Spike 5 — Multi-D1 + DO-SQLite

- Multiple D1 bindings on a single Worker: ___
- DO-SQLite available: ___
- D1 cross-region read latency: ___
- DO-SQLite read/write latency: ___

## Spike 6 — Workers Paid plan + CPU budget

- Workers Paid plan active: ___
- Raised `cpu_ms` works (deploy succeeded): ___
- PBKDF2-600k baseline timing: ___ ms
- Argon2id (real wasm) timing: ___ ms
- Decision on Argon2id placement (request path vs deferred): ___

---

## Aggregate decision

After all spikes pass, sign off here to proceed to Phase 0:

- [ ] All Critical spikes (1, 5) pass
- [ ] All High spikes (2, 3, 6) pass
- [ ] Spike 4 documented (informs FBL parser design in Phase 4)

Date: ___
Operator: ___
