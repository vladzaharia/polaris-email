// Scheduled (cron) dispatcher for polaris-email-api.
//
// Cron triggers and their handlers (all routed off `event.cron`):
//   * `0 * * * *`           — hourly audit anchor                → anchor
//   * `0 9 * * 1`           — weekly control-plane staleness     → staleness
//   * `* * * * *`           — per-minute synthetic /healthz probe → synthetic
//   * `0 3 * * *`           — nightly retention janitor           → janitor
//   * `*/15 * * * *`        — W2c sender abuse threshold cron    → senderAbuseThresholdRun
//
// Absorbed from the standalone `services/cron` Worker in phase B1.
import { anchor } from './anchor.js';
import { janitor } from './janitor.js';
import { staleness } from './staleness.js';
import { synthetic } from './synthetic.js';
import { senderAbuseThresholdRun } from './sender-abuse-threshold.js';
import { dmarcPromoteRun } from './dmarc-promote.js';
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
    case '*/15 * * * *': {
      // W2c — sender abuse threshold. Logged so the cron's effect is
      // observable in Workers logs without an extra metric.
      const r = await senderAbuseThresholdRun(env);
      // eslint-disable-next-line no-console
      console.log('sender-abuse-threshold cron:', `candidates=${r.candidates} fired=${r.fired}`);
      return;
    }
    case '0 4 * * *': {
      // W8 — DMARC policy auto-promotion. Daily.
      const r = await dmarcPromoteRun(env);
      // eslint-disable-next-line no-console
      console.log(
        'dmarc-promote cron:',
        `candidates=${r.candidates} promoted=${r.promoted} paused=${r.paused} noop=${r.noOp}`,
      );
      return;
    }
    default:
      // eslint-disable-next-line no-console
      console.warn(`scheduled: unknown cron ${event.cron}`);
  }
}
