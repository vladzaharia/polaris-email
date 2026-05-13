// Janitor: nightly Cron that enforces retention per tenant + scrubs transient material.
//
// The retention sweep itself is parked until the v1 schema gains a per-tenant
// retention_days column — see PROGRESS.md item 1 (modular monolith collapse).
// Until then this cron is a no-op so cf cron keeps reporting healthy and the
// audit trail records the run.
interface Env {
  DB: D1Database;
  R2: R2Bucket;
}

export default {
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // No-op until retention is wired against the v1 schema.
    // eslint-disable-next-line no-console
    console.log('janitor: no-op (retention sweep parked until v1 retention column lands)');
  },
};
