# Root-level variables. The single `envs/prod` configuration redeclares the
# subset it actually needs and forwards them to module/provider blocks. We
# keep them centralized here so docs/tooling have one source of truth for
# variable names + descriptions.
#
# Phase O1 collapsed three accounts to one. The previous `_prod`/`_staging`/
# `_anchors` account-id variables were merged into a single
# `cloudflare_account_id`; the `environment` discriminator was removed since
# there is only one composition under `envs/`.

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token used by the provider. MUST be scoped narrowly:
      - Zone:Read, Zone:Edit (DNS, Email Routing) on the relevant zones
      - Account:Read on the `polaris-prod` account
      - Account.Email Routing:Edit
      - Account.Access: Apps and Policies:Edit
    Do NOT use a global API key. Provision a Polaris-scoped token and pass
    it in via TF_VAR_cloudflare_api_token from a secret manager.
  EOT
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for `polaris-prod` (Workers + control plane + DNS + Access)."
  type        = string
  # TODO(operator): set via terraform.tfvars or TF_VAR_cloudflare_account_id.
}
