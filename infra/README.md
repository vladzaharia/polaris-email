# Polaris infrastructure

Polaris splits infrastructure-as-code along a deploy-cadence boundary.
**Terraform** (`infra/terraform/`) owns the slow-moving, cross-account,
state-shaped Cloudflare resources — DNS, Email Routing, Email Service
onboarding, Cloudflare Access apps, and the audit-anchor R2 bucket — across
the three accounts (`polaris-prod`, `polaris-staging`, `polaris-anchors`).
**Wrangler** (in each `apps/*/wrangler.jsonc`) owns the code-velocity
resources within `polaris-prod` / `polaris-staging`: Workers, D1, KV, R2 (in
those accounts), Queues, and Durable Objects. The two never overlap, and
the API tokens that drive each pipeline are scoped so they can't. See
`infra/terraform/README.md` for setup, drift policy, and the operator TODO
list.
