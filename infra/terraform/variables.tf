# Root-level variables. Each `envs/<env>` configuration redeclares the subset
# it actually needs and forwards them to module/provider blocks. We keep them
# centralized here so docs/tooling have one source of truth for variable
# names + descriptions.

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token used by the provider. MUST be scoped narrowly:
      - Zone:Read, Zone:Edit (DNS, Email Routing) on the relevant zones
      - Account:Read on each of the three accounts being managed
      - Account.Email Routing:Edit
      - Account.Access: Apps and Policies:Edit (for prod only)
      - Account.R2:Edit (anchors only — see envs/anchors)
    Do NOT use a global API key. Provision per-environment tokens if possible
    and pass them in via TF_VAR_cloudflare_api_token from a secret manager.
  EOT
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id_prod" {
  description = "Cloudflare account ID for `polaris-prod` (Workers + control plane)."
  type        = string
  # TODO(operator): set via terraform.tfvars or TF_VAR_cloudflare_account_id_prod.
}

variable "cloudflare_account_id_anchors" {
  description = "Cloudflare account ID for `polaris-anchors` (R2-only, audit anchor bucket, two-person-rule isolation)."
  type        = string
  # TODO(operator): set via terraform.tfvars or TF_VAR_cloudflare_account_id_anchors.
}

variable "cloudflare_account_id_staging" {
  description = "Cloudflare account ID for `polaris-staging` (full mirror of prod for staging tenants)."
  type        = string
  # TODO(operator): set via terraform.tfvars or TF_VAR_cloudflare_account_id_staging.
}

variable "environment" {
  description = "Logical environment name (`prod`, `staging`, `anchors`). Used for tagging + module naming."
  type        = string
  validation {
    condition     = contains(["prod", "staging", "anchors"], var.environment)
    error_message = "environment must be one of: prod, staging, anchors."
  }
}
