# Phase −1 — Cloudflare API spike

Empirically verify the Cloudflare assumptions baked into the design before any
schema or code work begins. Each script in `scripts/spike/` answers a specific
question; results land in `docs/spike/results.md` (operator-maintained).

These spikes require **live Cloudflare API access** with a token holding:

- `Account › Workers Scripts: Edit`
- `Account › Workers KV Storage: Edit`
- `Account › D1: Edit`
- `Account › Durable Objects: Edit`
- `Account › Email Routing Addresses: Edit`
- `Account › Email Service: Edit` (if available)
- `Zone › Email Routing Rules: Edit`
- `Zone › DNS: Edit`

Set the following env vars before running any spike:

```bash
export CF_API_TOKEN=...           # scoped token above
export CF_ACCOUNT_ID=...
export CF_TEST_ZONE_ID=...        # a throwaway zone you control
export CF_TEST_DOMAIN=...         # the zone name (e.g. example.com)
```

## Spikes (run in order)

| # | Script | Question answered |
|---|---|---|
| 1 | `01-email-service-binding-model.sh` | Is the `EMAIL` binding account-level (`from` parameter) or per-domain (one binding per onboarded zone)? **The plan dies at 30 domains if per-domain.** (I9) |
| 2 | `02-email-routing-and-service-coexist.sh` | Can Email Routing (MX → Worker) and Email Service (outbound) coexist on the same zone, including the `cf-bounce` MX record? (Decision 1) |
| 3 | `03-wildcard-dkim-and-mx.sh` | Does a wildcard DKIM CNAME (`*._domainkey.<zone>`) sign mail from `*@<sub>.<zone>`? Does a wildcard Email Routing rule (`*@*.<zone>`) catch all subdomains? (Resolved Q6) |
| 4 | `04-cf-bounce-mx-semantics.sh` | What does the `cf-bounce` MX deliver to our handler on hard bounce / soft bounce / complaint? Format? (security N2) |
| 5 | `05-d1-cross-binding-and-do-sqlite.sh` | Can a single Worker bind multiple D1 databases and query each? Are Durable Objects with SQLite available and stable enough for delivery state? (I3) |
| 6 | `06-workers-paid-cpu-budget.sh` | Confirm Workers Paid plan is active and `cpu_ms` is raisable per Worker. Measure Argon2id cost on a real isolate to size the move-out-of-request-path decision. (I5) |

After all spikes pass, fill out `results.md` and proceed to Phase 0.

## Output format

Each script prints:
- The exact API calls it made (curl commands)
- The relevant fragments of each response
- A pass/fail line at the end (`SPIKE_RESULT: PASS|FAIL — <why>`)

Capture stdout to `docs/spike/results/NN-<name>.log` for the record.
