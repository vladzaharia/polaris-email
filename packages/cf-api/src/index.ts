// @polaris-email/cf-api — Cloudflare API client + domain lifecycle automation.
//
// Used by the modular monolith Worker (workers/control-plane) and the polaris-email
// CLI to provision DNS, Email Routing rules, Email Service onboarding, DKIM
// rotation with overlap, and full domain decommission with DoH read-back gates.

export { CloudflareApiClient, CloudflareApiError } from './client.js';
export type { CloudflareApiClientOptions, CloudflareErrorEntry } from './client.js';

export {
  enableEmailRouting,
  disableEmailRouting,
  getEmailRoutingSettings,
  listEmailRoutingRules,
  createEmailRoutingRule,
  updateEmailRoutingRule,
  deleteEmailRoutingRule,
  setCatchAllRule,
} from './email-routing.js';

export {
  onboardSenderDomain,
  verifyOnboarding,
  unboardSenderDomain,
  type OnboardSenderDomainOpts,
  type OnboardResult,
} from './email-service.js';

export {
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  findRecord,
  type DnsRecordInput,
} from './dns.js';

export { findZoneByName, getZone, listZones } from './zones.js';

export { DohDnsVerifier, type VerifyStep, type DnsVerifier } from './dns-verify.js';

export type { ExpectedRecord, Zone, EmailRoutingRule } from './types.js';

// Cloudflare API helpers used by services/api admin routes.
// Implementations live alongside the rest of the package and follow the same
// shape: thin orchestration over the lower-level dns/email-routing/email-service
// helpers, with state machines for rotation + decommission per the plan.
export {
  planRotation,
  promotePending,
  retireOldKey,
  RETIRE_FLUSH_WINDOW_DAYS,
  type DkimKey,
  type DkimKeyOps,
  type DnsOps,
} from './dkim-rotation.js';

export { Decommissioner, type DecomState, type DecomDeps } from './decommission.js';

export {
  bulkOnboardPattern,
  type BulkOnboardOpts,
  type BulkOnboardProgress,
} from './bulk-onboard.js';

// `signed-urls.ts` was deleted in B5 — message bodies + attachments are now
// served from the R2 public custom domain `r2.mail.plrs.im` directly. The
// URL builder lives in `services/api/src/lib/r2-public-url.ts`.
