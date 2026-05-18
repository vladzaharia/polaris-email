# Polaris infrastructure

Polaris splits infrastructure-as-code along a deploy-cadence boundary.
**Terraform** (`infra/terraform/`) owns the slow-moving, state-shaped
Cloudflare resources — DNS, Email Routing, Email Service onboarding,
Cloudflare Access apps, the R2 public custom-domain wiring, Logpush
jobs, and R2 lifecycle rules — inside the single `polaris-prod` account.
**Wrangler** (in each `services/*/wrangler.jsonc` / `apps/*/wrangler.jsonc`)
owns the code-velocity resources within that same account: Workers, D1,
KV, R2 buckets, Queues, and Durable Objects. The two never overlap, and
the API tokens that drive each pipeline are scoped so they can't.
Tamper-evidence on `audit_log` is the in-row chained-hash invariant
plus the nightly `audit-verify` cron; see `infra/terraform/README.md`
for setup, drift policy, and the operator TODO list.
