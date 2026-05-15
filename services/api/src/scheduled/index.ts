// Scheduled (cron) dispatcher for polaris-email-api.
//
// Cron triggers and their handlers (all routed off `event.cron`):
//   * `0 * * * *` — hourly audit anchor                → anchor
//   * `0 9 * * 1` — weekly control-plane staleness     → staleness
//   * `* * * * *` — per-minute synthetic /healthz probe → synthetic
//   * `0 3 * * *` — nightly retention janitor           → janitor
//
// Absorbed from the standalone `services/cron` Worker in phase B1.
import { anchor } from './anchor.js';
import { janitor } from './janitor.js';
import { staleness } from './staleness.js';
import { synthetic } from './synthetic.js';
import type { Env } from '../env.js';

export async function scheduled(event: ScheduledEvent, env: Env): Promise<void> {
  switch (event.cron) {
    case '0 * * * *':
      return anchor(env);
    case '0 9 * * 1':
      return staleness(env);
    case '* * * * *':
      return synthetic(env);
    case '0 3 * * *':
      return janitor(env);
    default:
      // eslint-disable-next-line no-console
      console.warn(`scheduled: unknown cron ${event.cron}`);
  }
}
