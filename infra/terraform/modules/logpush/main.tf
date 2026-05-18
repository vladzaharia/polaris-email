# Cloudflare Logpush — Workers logs → external HTTP sink.
#
# Forwards the `workers_trace_events` dataset (Workers execution logs) to a
# single HTTP destination (Better Stack / Honeycomb / Datadog / etc.). The
# four production Workers all set `logpush: true` in wrangler.jsonc and
# emit into this dataset; Logpush batches and POSTs them to the
# destination URL.
#
# Why account-level (not zone-level): the workers dataset is account-scoped
# in Cloudflare's Logpush taxonomy. One job covers every Worker on the
# account, including the new services/tail Worker.
#
# Usage:
#   module "logpush_workers" {
#     source            = "../../modules/logpush"
#     cf_account_id     = var.cloudflare_account_id
#     destination_url   = var.logpush_destination_url   # e.g. https://in.logs.betterstack.com/?source_token=XXX
#     name              = "workers-to-betterstack"
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

variable "destination_url" {
  type        = string
  sensitive   = true
  description = <<-EOT
    HTTP sink URL. Provider format depends on the destination:
      * Better Stack: https://in.logs.betterstack.com/?source_token=<TOKEN>
      * Honeycomb:    https://api.honeycomb.io/1/events/<DATASET>
      * Datadog:      https://http-intake.logs.datadoghq.com/api/v2/logs?dd-api-key=<KEY>
    The token is embedded in the URL; treat the whole var as sensitive.
  EOT
}

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

resource "cloudflare_logpush_job" "workers" {
  account_id          = var.cf_account_id
  name                = var.name
  enabled             = true
  dataset             = "workers_trace_events"
  destination_conf    = var.destination_url
  filter              = var.filter
  output_options {
    field_names = var.fields
    timestamp_format = "rfc3339"
  }
}

output "job_id" {
  value       = cloudflare_logpush_job.workers.id
  description = "The Logpush job ID. Use in the dashboard to verify deliveries."
}
