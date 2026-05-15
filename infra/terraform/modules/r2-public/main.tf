# R2 public custom domain for the `polaris-email` bucket (B5).
#
# The bucket is fronted by `r2.mail.plrs.im`. Inbound + outbound message
# bodies and per-attachment R2 objects are served from this hostname; the
# `body_url` + `attachment.url` fields in API responses point here directly.
# Keys are content-addressed (SHA-256), so unguessability comes from the
# key itself — no signing.
#
# IMPORTANT: this module is intentionally NOT applied to `polaris-anchors`.
# That bucket holds audit anchors and stays private. The B5 cutover deletes
# the previous signed-URL endpoint; rolling back requires re-enabling that
# endpoint, NOT toggling the bucket back to private.

# --- DNS CNAME ----------------------------------------------------------------

resource "cloudflare_record" "r2_custom_domain_cname" {
  zone_id = var.cf_zone_id
  name    = var.record_name
  type    = "CNAME"
  # The R2 platform routes the custom domain to the bucket via the standard
  # `public.r2.dev` endpoint (Cloudflare's documented target for managed
  # custom domains). Operators MUST verify the exact target hostname in the
  # R2 dashboard the first time this is applied — the value below tracks the
  # currently-documented format and may evolve.
  content = "public.r2.dev"
  ttl     = 1 # 1 = automatic
  proxied = true
  comment = "Polaris: R2 public custom domain (managed by terraform, B5)"
}

# --- R2 custom domain binding -------------------------------------------------
#
# As of `cloudflare/cloudflare ~> 4.52` there is no first-class
# `cloudflare_r2_custom_domain` (or similar) resource — the API surface is
# still settling. We use a `null_resource` provisioner to invoke the R2
# Custom Domains API directly, with the same drift caveats noted on the
# `email_service_onboard` resource in `modules/zone/main.tf`. Replace this
# with a real provider resource once one ships.

resource "null_resource" "r2_custom_domain_attach" {
  triggers = {
    account_id  = var.cf_account_id
    bucket_name = var.bucket_name
    domain_name = var.domain_name
  }

  provisioner "local-exec" {
    # Requires CLOUDFLARE_API_TOKEN in env (do NOT pass via -X — it would
    # leak into shell history). The token needs `Account.R2:Edit` on the
    # owning account.
    command = <<-EOT
      echo "TODO: attach ${var.domain_name} to R2 bucket ${var.bucket_name} in account ${var.cf_account_id}"
      echo "TODO: replace with:"
      echo "  curl -X POST https://api.cloudflare.com/client/v4/accounts/${var.cf_account_id}/r2/buckets/${var.bucket_name}/domains/custom \\"
      echo "       -H 'Authorization: Bearer \$CLOUDFLARE_API_TOKEN' \\"
      echo "       -H 'Content-Type: application/json' \\"
      echo "       -d '{\"domain\":\"${var.domain_name}\",\"enabled\":true,\"minTLS\":\"1.2\"}'"
    EOT
  }

  depends_on = [cloudflare_record.r2_custom_domain_cname]
}
