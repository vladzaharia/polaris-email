# Cloudflare Logpush — Workers trace events → R2 (CF-native) or HTTP sink.
#
# Forwards the `workers_trace_events` dataset (Workers execution logs) to
# either:
#   * an R2 bucket on the same account (recommended — CF-native, no external
#     billing, retention controlled by R2 lifecycle rules), or
#   * an HTTP destination (Better Stack, Honeycomb, Datadog, etc.) for
#     real-time indexed observability.
#
# Choose exactly one. Module validates that.
#
# Why account-level (not zone-level): the workers dataset is account-scoped
# in Cloudflare's Logpush taxonomy. One job covers every Worker on the
# account, including the new services/tail Worker.
#
# R2 destination layout: logs land as ND-JSON gzip blobs under
# `s3://<bucket>/<prefix>/YYYY/MM/DD/HH/<job-id>-<batch>.log.gz`. Use the
# r2-lifecycle module to expire them on a schedule.
#
# R2 credentials: operators MUST create a separate R2 API token (R2
# dashboard → Manage R2 API Tokens) with **Object Read & Write** on the
# logs bucket. Do NOT reuse the main Cloudflare account API token — it
# doesn't have R2-compatible S3 credentials.
#
# Usage (R2):
#   module "logpush_workers" {
#     source                = "../../modules/logpush"
#     cf_account_id         = var.cloudflare_account_id
#     r2_bucket             = "polaris-email-logs"
#     r2_prefix             = "workers"
#     r2_access_key_id      = var.r2_logs_access_key_id
#     r2_secret_access_key  = var.r2_logs_secret_access_key
#   }
#
# Usage (HTTP fallback):
#   module "logpush_workers" {
#     source            = "../../modules/logpush"
#     cf_account_id     = var.cloudflare_account_id
#     destination_url   = var.logpush_destination_url   # e.g. https://in.logs.betterstack.com/?source_token=XXX
#   }

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
  }
}

variable "cf_account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "name" {
  type        = string
  description = "Logpush job name. Must be unique within the account."
  default     = "polaris-email-workers"
}

# --- HTTP destination ---------------------------------------------------

variable "destination_url" {
  type        = string
  sensitive   = true
  description = <<-EOT
    HTTP sink URL. Set this XOR the r2_* variables. Provider format
    depends on the destination:
      * Better Stack: https://in.logs.betterstack.com/?source_token=<TOKEN>
      * Honeycomb:    https://api.honeycomb.io/1/events/<DATASET>
      * Datadog:      https://http-intake.logs.datadoghq.com/api/v2/logs?dd-api-key=<KEY>
    The token is embedded in the URL; treat the whole var as sensitive.
  EOT
  default     = ""
}

# --- R2 destination -----------------------------------------------------

variable "r2_bucket" {
  type        = string
  description = "R2 bucket to receive logs. Set this + r2_access_key_id + r2_secret_access_key, XOR with destination_url."
  default     = ""
}

variable "r2_prefix" {
  type        = string
  description = "Key prefix inside the R2 bucket. Final layout is `<prefix>/YYYY/MM/DD/HH/<job>-<batch>.log.gz`."
  default     = "logs"
}

variable "r2_access_key_id" {
  type        = string
  description = "R2 API token's access key id (S3-compatible). Provision via R2 dashboard → Manage R2 API Tokens with Object R/W on the logs bucket."
  default     = ""
  sensitive   = true
}

variable "r2_secret_access_key" {
  type        = string
  description = "Matching R2 API token secret. Treat as sensitive."
  default     = ""
  sensitive   = true
}

# --- shared knobs -------------------------------------------------------

variable "filter" {
  type        = string
  description = <<-EOT
    Logpush filter expression. Defaults to forwarding only error /
    exception outcomes plus any custom error logs — set to `""` to
    forward everything (much higher volume / cost).
  EOT
  default     = "{\"where\":{\"and\":[{\"or\":[{\"key\":\"Outcome\",\"operator\":\"eq\",\"value\":\"exception\"},{\"key\":\"Outcome\",\"operator\":\"eq\",\"value\":\"exceededCpu\"},{\"key\":\"Outcome\",\"operator\":\"eq\",\"value\":\"unknown\"}]}]}}"
}

variable "fields" {
  type        = list(string)
  description = "Field names to include. Default covers everything useful."
  default = [
    "Event",
    "EventTimestampMs",
    "EventType",
    "Exceptions",
    "Logs",
    "Outcome",
    "ScriptName",
    "ScriptTags",
    "ScriptVersion",
  ]
}

# --- destination_conf computation --------------------------------------
#
# The R2 `destination_conf` URL embeds the access-key-id and secret in
# the URL query string. Cloudflare's API stores it server-side and only
# accepts updates that re-supply the full credential pair, so rotation
# is a `terraform apply` against a fresh secret_access_key — no partial
# updates.

locals {
  # exactly_one() enforces XOR at plan time.
  r2_configured   = var.r2_bucket != "" && var.r2_access_key_id != "" && var.r2_secret_access_key != ""
  http_configured = var.destination_url != ""

  # Build the R2 destination_conf URL when R2 is selected. The prefix is
  # joined with `/` so the resulting key is `<prefix>/YYYY/MM/DD/...`.
  r2_destination_conf = local.r2_configured ? format(
    "r2://%s/%s?account-id=%s&access-key-id=%s&secret-access-key=%s",
    var.r2_bucket,
    var.r2_prefix,
    var.cf_account_id,
    var.r2_access_key_id,
    var.r2_secret_access_key,
  ) : ""

  destination_conf = local.r2_configured ? local.r2_destination_conf : var.destination_url

  # Materialise the XOR check as a precondition so `terraform plan`
  # fails before any CF write.
  _xor_check = (
    (local.r2_configured && !local.http_configured) ||
    (!local.r2_configured && local.http_configured)
  ) ? true : tobool("logpush module: configure EITHER destination_url (HTTP sink) OR r2_bucket+r2_access_key_id+r2_secret_access_key (R2 sink), not both, not neither")
}

resource "cloudflare_logpush_job" "workers" {
  account_id       = var.cf_account_id
  name             = var.name
  enabled          = true
  dataset          = "workers_trace_events"
  destination_conf = local.destination_conf
  filter           = var.filter
  output_options {
    field_names      = var.fields
    timestamp_format = "rfc3339"
  }
}

output "job_id" {
  value       = cloudflare_logpush_job.workers.id
  description = "The Logpush job ID. Use in the dashboard to verify deliveries."
}

output "destination_kind" {
  value       = local.r2_configured ? "r2" : "http"
  description = "Which destination this job ships to. Read by other modules / smoke tests."
}
