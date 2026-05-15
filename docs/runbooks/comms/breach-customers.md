# Customer comms — polaris-email incident

Use this **only** after the internal incident commander has signed off. Replace bracketed sections.

**Subject:** [Update] polaris-email — email delivery temporarily paused

Hi —

We've temporarily paused polaris-email's outbound delivery and held inbound mail while we investigate [a security event / a control-plane anomaly / scheduled break-glass exercise — pick one]. Senders to your inbound addresses will see a 4xx tempfail and retry automatically; no mail is lost. Outbound transactional sends from your services are paused.

Expected resolution: [time window].

We'll send a follow-up once mail flow is restored and a separate communication once the post-incident review is complete.

— polaris-email ops
