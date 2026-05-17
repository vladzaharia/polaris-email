---
title: Customer comms template
description: Drop-in customer email draft for a polaris-email incident. Use only after the internal incident commander has signed off; replace bracketed sections.
sidebar_label: Customer comms
sidebar_position: 1
---

# Customer comms — polaris-email incident

Use this **only** after the internal incident commander has signed off. Replace bracketed sections.

**Subject:** [Update] polaris-email — email delivery temporarily paused

Hi
We've temporarily paused polaris-email's outbound delivery and held inbound mail while we investigate [a security event / a control-plane anomaly / scheduled break-glass exercise — pick one]. Senders to your inbound addresses will see a 4xx tempfail and retry automatically; no mail is lost. Outbound transactional sends from your services are paused.

Expected resolution: [time window].

We'll send a follow-up once mail flow is restored and a separate communication once the post-incident review is complete.

— polaris-email ops

<!-- Verified against: docs/runbooks/comms/breach-customers.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
