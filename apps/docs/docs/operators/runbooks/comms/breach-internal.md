---
title: Internal comms template
description: Drop-in internal-team incident update for a polaris-email investigation in progress. Status fields (containment, customer impact, owner, ticket) ready to fill in.
sidebar_label: Internal comms
sidebar_position: 2
---

# Internal comms — polaris-email incident

**Subject:** [INCIDENT] polaris-email — investigation in progress

Hi team,

We're investigating a possible compromise of polaris-email's Cloudflare account / control plane / bridge host (delete as appropriate). Current status:

- **Containment**: API in `503 degraded` mode; inbound MX flipped to a holding domain that 4xx-tempfails; panel offline.
- **Customer impact**: outbound mail blocked; inbound mail held with sender retries.
- **Owner**: \<name\>.
- **Linear ticket**: \<id\>.

We're operating under the [CF account compromise runbook](/operators/runbooks/cf-account-compromise). Next update in 60 minutes.

Please do not communicate externally until the customer comms draft is approved.

<!-- Verified against: docs/runbooks/comms/breach-internal.md @ c3c1b5048dd5bfe92facdce24982141a07446042 -->
