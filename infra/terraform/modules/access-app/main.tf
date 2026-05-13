# Cloudflare Access self-hosted application + policy.
#
# Used for: admin endpoints (`/admin/*` on the control-plane Worker) and
# `/v1/send/raw` on the submission ingress (per design finding C3 + I18).
# WebAuthn step-up gates destructive admin scopes.

resource "cloudflare_access_application" "this" {
  account_id                = var.cf_account_id
  zone_id                   = var.cf_zone_id
  name                      = var.app_name
  domain                    = var.domain
  type                      = "self_hosted"
  session_duration          = var.session_duration
  auto_redirect_to_identity = false
  app_launcher_visible      = false
  allowed_idps              = var.identity_provider_ids

  # Be strict about CORS by default — admin tools have no reason to allow
  # cross-origin requests. Operators can override per-app if needed.
  cors_headers {
    allow_credentials = false
    allowed_methods   = ["GET", "POST"]
    allowed_origins   = []
    max_age           = 0
  }
}

resource "cloudflare_access_policy" "allow_emails" {
  count = length(var.allowed_emails) > 0 ? 1 : 0

  account_id     = var.cf_account_id
  zone_id        = var.cf_zone_id
  application_id = cloudflare_access_application.this.id
  name           = "${var.app_name}-allow-emails"
  precedence     = 1
  decision       = "allow"

  include {
    email = var.allowed_emails
  }

  # WebAuthn purpose-bound step-up for destructive surfaces. The
  # `auth_method = "swk"` value corresponds to the SAML AuthnContext URI
  # for software-based hardware tokens; `mfa` requires any second factor.
  # We pick the strongest available: hardware key.
  dynamic "require" {
    for_each = var.require_webauthn_step_up ? [1] : []
    content {
      auth_method = "swk"
    }
  }
}
