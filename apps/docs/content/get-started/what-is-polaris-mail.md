---
title: What is polaris-mail?
description: Managed email service for the polaris-* family — Cloudflare Workers control plane, on-prem Go mail-bridge, admin panel, and Go operator CLI.
sidebar_label: What is polaris-mail?
sidebar_position: 1
slug: /
---

# What is polaris-mail?

A managed email service for the `polaris-*` family of internal apps.
One HMAC-signed REST contract handles both outbound submission and
inbound retrieval. v2-envelope signed webhooks deliver inbound events
to your services. Legacy SMTP / IMAP clients reach their mailboxes
through an on-prem Go bridge.

## Moving parts

- **Cloudflare Workers control plane** — three Workers: `services/api`
  (REST surface, webhook fan-out, cron), `services/in` (Email Routing
  inbound), `services/out` (Email Service outbound).
- **`apps/mail-bridge`** — a single Go binary serving SMTPS (`:465`)
  and IMAP4rev2 (`:993`) for on-prem clients. Two equally-supported
  deployment modes: tailnet-fronted and local / host-network.
- **`apps/panel`** — Hono + React 19 admin UI deployed as its own
  Worker. Mailboxes, API keys, routing, secrets, ops.
- **`apps/polaris-cli`** — Go operator CLI (`polaris-mail`, alias
  `pml`). Cold-start, day-2 ops, and the smoke checks.

Three Workers. Three apps. About a dozen shared TypeScript packages.

## Pick your path

- **Developer** integrating with the API → [Quickstart](/developers/quickstart).
- **Operator** standing up a deployment → [Prerequisites](/operators/deployment/prerequisites).
- **Contributor** working on the codebase → [Repo orientation](/contributing/repo-orientation).
- **Security reviewer** → [Threat model](/security/threat-model).

<!-- Verified against: README.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
