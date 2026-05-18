---
title: For operators
description: Stand up polaris-email from cold start, run it day-to-day with the polaris-email CLI, and recover from incidents using the runbook library. Covers Cloudflare-side deploys and the on-prem mail-bridge.
sidebar_label: Overview
sidebar_position: 0
---

# Operator documentation

You own the deployment. Pick the entry point that matches today's work.

## Cold-start a new deployment

→ **[Prerequisites](/operators/deployment/prerequisites)** — the
Cloudflare scopes and local tools the cold-start needs in place first.

→ **[Cold-start bootstrap](/operators/deployment/cold-start-bootstrap)** —
one path from an empty CF account to a green smoke. Target: ≤30 minutes.
The hero tutorial lives at [30-minute first deploy](/get-started/30-min-first-deploy).

→ **[Cloudflare Access setup](/operators/deployment/cloudflare-access)** —
OIDC IdP wiring, the `access-app` Terraform module, group-based role
sync, and the service-token model for daemons behind Access.

## Day-2 operations

→ **[CLI tour](/operators/day-2/cli-tour)** — the entry index for every
verb domain (`domain`, `cred`, `route`, `webhook`, `bridge`, `audit`,
`suppression`, `status`, `auth`).

| Workflow                                         | Page                                                            |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Onboard / configure / decommission domains       | [Domain management](/operators/day-2/domain-management)         |
| Manage mailboxes (the unit everything hangs off) | [Mailbox management](/operators/day-2/mailbox-management)       |
| Issue / rotate / revoke credentials              | [Credential management](/operators/day-2/credential-management) |
| Inbound routes and webhook DLQ                   | [Routing and webhooks](/operators/day-2/routing-and-webhooks)   |
| Register / rotate / deregister bridges           | [Bridge management](/operators/day-2/bridge-management)         |
| Rotate the bridge's TLS cert                     | [Bridge TLS](/operators/day-2/bridge-tls)                       |
| Watch the system from the outside                | [Monitoring](/operators/day-2/monitoring)                       |
| Daily snapshot of red/yellow/green               | [Activity inspection](/operators/day-2/activity-inspection)     |
| Weekly D1 export to R2                           | [D1 backup](/operators/day-2/d1-backup)                         |
| Point-in-time D1 restore (Time-Travel)           | [D1 recovery](/operators/day-2/d1-recovery)                     |

## Understand what runs where

→ **[Architecture](/operators/concepts/architecture)** — the three
Workers, the mailbox-centric schema, the unified pipeline, the
chained-hash audit log.

→ **[Cost model](/operators/concepts/cost-model)** — forward bill
projections at small / medium / large traffic tiers and the cliffs that
disproportionately blow the bill.

→ **[Mail bridge](/operators/concepts/mail-bridge)** — the on-prem Go
binary that fronts SMTPS and IMAP4rev2 for human-facing mailboxes. Two
equally-supported deployment modes: tailnet-fronted and host-network.

## Incident response

→ **[On-call runbook](/operators/runbooks)** — first commands and
decision trees for the common incidents (outbound failing, webhook DLQ
filling, bridge offline, audit chain break, D1 quota, cost spikes).

→ **[Troubleshooting decision matrix](/operators/troubleshooting/decision-matrix)** —
symptom → cause → fix index. The fast index when the on-call runbook
feels too deep.

Specialised playbooks:

- [Bridge credential sync](/operators/runbooks/bridge-credential-sync)
- [CF account compromise](/operators/runbooks/cf-account-compromise)
- [Control-plane secret rotation](/operators/runbooks/control-plane-rotation)
- [D1 recovery (PITR)](/operators/runbooks/d1-recovery)
- [Disaster recovery](/operators/runbooks/disaster-recovery)
- [Webhook DLQ](/operators/runbooks/webhook-dlq)
- [Retention and cleanup](/operators/runbooks/retention-and-cleanup)
- [Data residency](/operators/runbooks/data-residency)
- [Comms templates](/operators/runbooks/comms/breach-customers) (customer + internal)
