variable "cf_account_id" {
  description = "Cloudflare account ID hosting the Access app (typically the prod account)."
  type        = string
}

variable "cf_zone_id" {
  description = "Cloudflare zone ID the app is bound to. Must be in the same account as `cf_account_id`."
  type        = string
}

variable "app_name" {
  description = "Human-readable app name (shows up in the Access dashboard + login page)."
  type        = string
}

variable "domain" {
  description = "Fully-qualified domain Access protects, e.g. `admin.polaris.example.com`. Must resolve to a Worker route or origin in the same zone."
  type        = string
}

variable "session_duration" {
  description = "How long an Access session is valid before re-auth. Keep short for admin surfaces (default 1h)."
  type        = string
  default     = "1h"
}

variable "identity_provider_ids" {
  description = "List of Cloudflare Access identity provider IDs allowed to authenticate (e.g. WebAuthn, GitHub, OIDC). TODO(operator): fetch IDs from `cloudflare_access_identity_provider` data sources or the dashboard."
  type        = list(string)
}

variable "allowed_emails" {
  description = "Email addresses allowed through the policy. Use sparingly; prefer group-based policies when an IdP supports them."
  type        = list(string)
  default     = []
}

variable "require_webauthn_step_up" {
  description = "If true, require a WebAuthn purpose-bound key (security key) at session start. Used for destructive admin scopes per finding C3 in the design audit."
  type        = bool
  default     = true
}
