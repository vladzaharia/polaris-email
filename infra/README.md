# Polaris infrastructure

Polaris splits infrastructure-as-code along a deploy-cadence boundary.
**Terraform** (`infra/terraform/`) owns the slow-moving, state-shaped
Cloudflare resources — DNS, Email Routing, Email Service onboarding,
Cloudflare Access apps, and the R2 public custom-domain wiring — inside the
single `polaris-prod` account (Phase O1 collapsed the previous three-account
topology to one). **Wrangler** (in each `services/*/wrangler.jsonc` /
`apps/*/wrangler.jsonc`) owns the code-velocity resources within that same
account: Workers, D1, KV, R2 buckets, Queues, and Durable Objects. The two
never overlap, and the API tokens that drive each pipeline are scoped so
they can't. Audit anchors live off-Cloudflare in Backblaze B2 with Object
Lock COMPLIANCE; see `infra/terraform/README.md` for setup, drift policy,
the anchor-target setup, and the operator TODO list.
