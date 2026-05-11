# Internal comms — polaris-email incident

**Subject:** [INCIDENT] polaris-email — investigation in progress

Hi team,

We're investigating a possible compromise of polaris-email's Cloudflare account / control plane / bridge host (delete as appropriate). Current status:

- **Containment**: API in `503 degraded` mode; inbound MX flipped to a holding domain that 4xx-tempfails; panel offline.
- **Customer impact**: outbound mail blocked; inbound mail held with sender retries.
- **Owner**: <name>.
- **Linear ticket**: <id>.

We're operating under the runbook at `RUNBOOKS/cf-account-compromise.md`. Next update in 60 minutes.

Please do not communicate externally until the customer comms draft is approved.
