# R2 lifecycle rules for the polaris-email bucket.
#
# Two rules:
#   1. `mime/`  + `att/` (message bodies and attachments) age out at 90 days.
#      The janitor cron in services/api/src/scheduled/janitor.ts still
#      handles reference-counted deletes; this rule is a backstop for
#      orphaned objects (refcount-cron failure, or content the janitor
#      hasn't gotten to yet). Set `expire_after_days = 0` to disable.
#   2. `backups/d1/` (weekly D1 export, see d1-backup cron) age out at
#      12 weeks (~84 days).
#
# Lifecycle rules are evaluated by R2 daily. Deletions are immediate at
# the rule boundary (no transition window).

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

variable "bucket_name" {
  type        = string
  description = "R2 bucket the rules apply to."
  default     = "polaris-email"
}

variable "message_body_expire_days" {
  type        = number
  description = "Age in days at which mime/ and att/ prefix objects expire."
  default     = 90
}

variable "backup_expire_days" {
  type        = number
  description = "Age in days at which backups/d1/ prefix objects expire."
  default     = 84
}

resource "cloudflare_r2_bucket_lifecycle" "polaris_email" {
  account_id  = var.cf_account_id
  bucket_name = var.bucket_name

  rule {
    id      = "message-bodies"
    enabled = true
    conditions {
      prefix = "mime/"
    }
    delete_objects_transition {
      condition {
        type   = "Age"
        max_age = var.message_body_expire_days * 24 * 60 * 60 # seconds
      }
    }
  }

  rule {
    id      = "attachments"
    enabled = true
    conditions {
      prefix = "att/"
    }
    delete_objects_transition {
      condition {
        type   = "Age"
        max_age = var.message_body_expire_days * 24 * 60 * 60
      }
    }
  }

  rule {
    id      = "d1-backups"
    enabled = true
    conditions {
      prefix = "backups/d1/"
    }
    delete_objects_transition {
      condition {
        type   = "Age"
        max_age = var.backup_expire_days * 24 * 60 * 60
      }
    }
  }
}

output "rule_count" {
  value       = 3
  description = "Number of lifecycle rules provisioned. Bump when adding rules above."
}
