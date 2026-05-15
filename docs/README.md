# polaris-email docs

Tailnet-internal documentation for integrators and operators of `polaris-email`.

- **Quickstart**: [quickstart/README.md](quickstart/README.md) — send your first email in 5 minutes.
- **HMAC reference**: [hmac-reference.md](hmac-reference.md) — canonical-string spec + test vectors.
- **Error catalog**: [errors.md](errors.md) — every error code + retry semantics.
- **Webhook decision tree**: [webhook-decision-tree.md](webhook-decision-tree.md) — external vs Tailnet-direct vs bridge-proxied.
- **SMTP cookbook**: [smtp-cookbook/README.md](smtp-cookbook/README.md) — per-library configuration for 465 SMTPS.
- **Operator runbooks**: under `runbooks/` — incident response, account compromise, rotations.
- **Operator guide**: [operator.md](operator.md) — day-to-day workflows.
- **Deploy runbook**: [deploy.md](deploy.md) — cold-start + infrastructure.
- **On-call runbook**: [runbook.md](runbook.md) — triage at 3 AM.
- **CLI vocabulary**: [cli.md](cli.md) — revoke vs deregister vs disable vs delete.

OpenAPI spec: [openapi/polaris-email.yaml](../openapi/polaris-email.yaml).
