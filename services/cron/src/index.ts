// Cron Worker: dispatches scheduled events to the right handler.
import { anchor } from './handlers/anchor.js';
import { janitor } from './handlers/janitor.js';
import { staleness } from './handlers/staleness.js';
import { synthetic } from './handlers/synthetic.js';
import type { Env } from './env.js';

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
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
        console.warn(`cron: unknown schedule ${event.cron}`);
    }
  },
};
