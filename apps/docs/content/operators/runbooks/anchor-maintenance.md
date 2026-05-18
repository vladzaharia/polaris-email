---
title: Anchor maintenance (removed)
sidebar_position: 999
description: The off-platform audit-anchor mechanism (Backblaze B2 + Object Lock COMPLIANCE) was removed. This page is a stub kept so existing inbound links don't 404; the procedures it documented no longer apply.
---

# Anchor maintenance (removed)

This runbook described how to verify and rotate hourly audit anchors
written to a Backblaze B2 bucket with Object Lock COMPLIANCE retention.
**The mechanism was removed.** The page is kept as a stub so existing
inbound links don't 404; the procedures it documented no longer apply.

## What replaced it

The `audit_log` table retains its in-row chained-hash invariant: each
row's `row_hash` is `SHA-256(prev_hash || canonical(row))`, so any
out-of-band rewrite breaks the chain. The `audit-verify` cron walks the
chain end-to-end nightly and writes the result to `cron_runs`. The panel
"Audit chain" diagnostics card surfaces the head hash + freshness.

For recovery after a full-account compromise (the scenario anchors were
designed to address) the surfaces are now:

- [D1 point-in-time recovery](./d1-recovery.md) — ~30-day rollback window.
- [Cloudflare account compromise](./cf-account-compromise.md) —
  containment + Logpush-mirror investigation.

The accepted trade-off is documented in `SECURITY.md` under
"Audit chain integrity".
