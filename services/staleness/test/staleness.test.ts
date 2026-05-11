import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('staleness', () => {
  it('runs with no audit rows', async () => {
    const env = {
      DB: {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return { at: null };
            },
          };
        },
      } as unknown as D1Database,
      ALERT_WEBHOOK: '',
    };
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });
});
