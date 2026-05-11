# Runbook: data residency

polaris-email's stored data:

- **D1** — declared in `services/api/wrangler.local.jsonc` as `database_name` + `location: 'weur'` (configurable).
- **R2** — declared in `services/api/wrangler.local.jsonc` as `bucket_name` + `jurisdiction: 'eu'` (configurable). Object Lock enabled in compliance mode.
- **Email Routing inbound** — CF's regional routing follows the domain's MX, which lands in CF's nearest colo. Use a regional CF account to constrain.
- **Workers** — `placement: { mode: 'smart' }` keeps execution close to D1/R2.
- **Bridge Mox storage** — on the bridge host's local volume (operator-managed).
- **Panel sqlite** — sessions only; on the panel container's volume.

## Verifying

```sh
bin/data-residency-report.sh
```

Inspects each binding via `wrangler` and prints the actual jurisdiction. Compares against the declared values; nonzero exit if drift.

## Right-to-erasure

To erase all messages concerning a specific recipient (with proof of consent / legal request):

```sh
bin/erasure.sh --plaintext "user@external.com" --ticket "ER-1234"
```

This:
1. Computes the per-service HMAC `to_hash` for the address.
2. POSTs `/v1/admin/erasure` with `{recipient_hash, justification, ticket_id}`.
3. The api Worker zeroes PII columns in D1 and places delete-markers on R2 (Object Lock blocks immediate erasure).
4. Audited as `service.update` with the ticket id.
