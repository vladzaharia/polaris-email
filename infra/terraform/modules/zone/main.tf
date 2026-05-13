# Per-zone DNS + Email Routing wiring for a Polaris-managed domain.
#
# Scope: this module owns *all* MX/SPF/DKIM/DMARC records for the zone. If the
# operator has previously hand-rolled records via the dashboard, they MUST be
# imported (or deleted) before applying — terraform will overwrite them.
#
# Out of scope: zone creation, registrar-side NS pointers, BIMI, MTA-STS
# policies (latter two tracked in the design's H-tier findings).

locals {
  # Cloudflare Email Routing inbound MX targets. These are stable at the
  # service level — confirmed against CF docs as of writing. If Cloudflare
  # ever changes them, dashboard would show drift.
  email_routing_mx = [
    { server = "route1.mx.cloudflare.net", priority = 13 },
    { server = "route2.mx.cloudflare.net", priority = 86 },
    { server = "route3.mx.cloudflare.net", priority = 24 },
  ]

  dkim_record_name = "${var.dkim_selector}._domainkey"

  dmarc_value_parts = compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    var.dmarc_rua != "" ? "rua=${var.dmarc_rua}" : "",
  ])
  dmarc_value = join("; ", local.dmarc_value_parts)
}

# --- Inbound MX (Email Routing) -----------------------------------------------

resource "cloudflare_record" "mx_email_routing" {
  for_each = var.capabilities.inbound ? { for r in local.email_routing_mx : r.server => r } : {}

  zone_id  = var.cf_zone_id
  name     = var.domain_name
  type     = "MX"
  content  = each.value.server
  priority = each.value.priority
  ttl      = 1 # 1 = automatic
  comment  = "Polaris: Email Routing inbound MX (managed by terraform)"
}

# --- Bounce MX (Email Service outbound) ---------------------------------------
# Cloudflare Email Service uses a per-account bounce subdomain. The exact
# host depends on account onboarding; documented as `cf-bounce.<account>...`
# in CF docs. We model it as a plain MX so the operator can override.
resource "cloudflare_record" "mx_bounce" {
  count = var.capabilities.outbound ? 1 : 0

  zone_id  = var.cf_zone_id
  name     = "cf-bounce.${var.domain_name}"
  type     = "MX"
  content  = "route1.mx.cloudflare.net" # TODO(operator): swap to per-account bounce target once onboarded
  priority = 10
  ttl      = 1
  comment  = "Polaris: Email Service bounce MX (managed by terraform; verify target after first onboard)"
}

# --- SPF -----------------------------------------------------------------------

resource "cloudflare_record" "spf" {
  count = var.capabilities.outbound || var.capabilities.inbound ? 1 : 0

  zone_id = var.cf_zone_id
  name    = var.domain_name
  type    = "TXT"
  content = var.spf_record
  ttl     = 1
  comment = "Polaris: SPF (managed by terraform)"
}

# --- DKIM CNAME ----------------------------------------------------------------

resource "cloudflare_record" "dkim" {
  count = var.capabilities.outbound ? 1 : 0

  zone_id = var.cf_zone_id
  name    = local.dkim_record_name
  type    = "CNAME"
  content = var.dkim_cname_target
  ttl     = 1
  proxied = false
  comment = "Polaris: DKIM ${var.dkim_selector} (managed by terraform)"
}

resource "cloudflare_record" "dkim_wildcard" {
  count = var.capabilities.outbound && var.include_dkim_wildcard ? 1 : 0

  zone_id = var.cf_zone_id
  name    = "*._domainkey"
  type    = "CNAME"
  content = var.dkim_cname_target
  ttl     = 1
  proxied = false
  comment = "Polaris: DKIM wildcard (managed by terraform)"
}

# --- DMARC ---------------------------------------------------------------------

resource "cloudflare_record" "dmarc" {
  count = var.capabilities.outbound ? 1 : 0

  zone_id = var.cf_zone_id
  name    = "_dmarc"
  type    = "TXT"
  content = local.dmarc_value
  ttl     = 1
  comment = "Polaris: DMARC (managed by terraform)"
}

# --- Email Routing settings + catch-all rule ----------------------------------

resource "cloudflare_email_routing_settings" "this" {
  count = var.enable_email_routing && var.capabilities.inbound ? 1 : 0

  zone_id = var.cf_zone_id
  enabled = true
  # `skip_wizard = true` because we provision MX records ourselves above and
  # don't want the dashboard wizard to fight us.
  skip_wizard = true
}

resource "cloudflare_email_routing_catch_all" "this" {
  count = var.enable_email_routing && var.capabilities.inbound ? 1 : 0

  zone_id = var.cf_zone_id
  name    = "polaris-catch-all"
  enabled = true

  matcher {
    type = "all"
  }

  action {
    type  = "worker"
    value = [var.inbound_worker_name]
  }

  depends_on = [cloudflare_email_routing_settings.this]
}

# --- Email Service domain onboarding (TODO) -----------------------------------
#
# As of cloudflare/cloudflare ~> 4.52 (and as of the design plan's writing in
# May 2026), there is NO first-class `cloudflare_email_service_domain` (or
# similar) resource for onboarding a sender domain to Cloudflare Email Service
# (the outbound `EMAIL` binding). The provider exposes Email Routing
# (inbound) but not the Email Service (outbound) onboarding API.
#
# Until the provider catches up, we use a `null_resource` provisioner to call
# the Email Service onboarding endpoint directly. This is intentionally
# low-fidelity — it tracks creation but not drift; if the operator changes
# something via dashboard, terraform won't notice. The drift policy in the
# README forbids that.
#
# TODO(operator):
#   1. Confirm the actual Email Service onboarding API path + payload from
#      Cloudflare docs (the API surface is still in flux).
#   2. Replace the placeholder curl below with a real call.
#   3. Pipe the returned DKIM target hostname back into `var.dkim_cname_target`
#      via a data source or remote state output once a real resource exists.

resource "null_resource" "email_service_onboard" {
  count = var.capabilities.outbound ? 1 : 0

  triggers = {
    domain     = var.domain_name
    account_id = var.cf_account_id
    selector   = var.dkim_selector
  }

  provisioner "local-exec" {
    # NOTE: requires CLOUDFLARE_API_TOKEN env var to be set when running
    # `terraform apply`. We do NOT pass the token via -X args because that
    # would leak into shell history.
    command = <<-EOT
      echo "TODO: onboard ${var.domain_name} (selector=${var.dkim_selector}) to Cloudflare Email Service in account ${var.cf_account_id}"
      echo "TODO: replace with: curl -X POST https://api.cloudflare.com/client/v4/accounts/${var.cf_account_id}/email/service/domains \\"
      echo "                          -H 'Authorization: Bearer \$CLOUDFLARE_API_TOKEN' \\"
      echo "                          -H 'Content-Type: application/json' \\"
      echo "                          -d '{\"domain\":\"${var.domain_name}\",\"dkim_selector\":\"${var.dkim_selector}\"}'"
    EOT
  }
}
