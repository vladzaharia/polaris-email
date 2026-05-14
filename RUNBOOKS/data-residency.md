# Runbook: data residency

polaris-email's stored data:

- **D1** — declared in `services/api/wrangler.local.jsonc` as `database_name` + `location: 'weur'` (configurable).
- **R2** — declared in `services/api/wrangler.local.jsonc` as `bucket_name` + `jurisdiction: 'eu'` (configurable). Object Lock enabled in compliance mode.
- **Email Routing inbound** — CF's regional routing follows the domain's MX, which lands in CF's nearest colo. Use a regional CF account to constrain.
- **Workers** — `placement: { mode: 'smart' }` keeps execution close to D1/R2.
- **Submission-daemon SQLite mirror** — on each daemon host's local volume (operator-managed). Holds credential bcrypt hashes only, never plaintext.
- **Panel sqlite** — sessions only; on the panel container's volume.

## Verifying

Use the polaris-email CLI to inventory the stack:

```sh
polaris-email domain list           # mail_domains, including jurisdiction hints
polaris-email cred list --tenant T  # api keys + smtp credentials for tenant T
polaris-email status                # high-level counts
```

For deeper jurisdiction inspection, query the bindings directly via `wrangler d1
info` and `wrangler r2 bucket info`.

## Right-to-erasure

Erasure is not yet a first-class operation. The current path:

1. Identify the affected messages via the audit log + `messages` table (`tenant_id`
   - recipient hash columns).
2. Manually `wrangler d1 execute` a DELETE for the relevant rows.
3. R2 Object Lock blocks immediate erasure; place delete markers and accept that the
   underlying objects expire on the configured retention window.
4. Audit-log the ticket id manually via `polaris-email audit chain`.
