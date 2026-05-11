import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('synthetic', () => {
  it('does not throw without key configured', async () => {
    const env = {
      API_BASE_URL: 'https://x',
      ALERT_WEBHOOK: '',
      SYNTHETIC_FROM: 'a@b',
      SYNTHETIC_TO: 'c@d',
      MAX_LATENCY_MS: '30000',
    };
    await expect(
      worker.scheduled(
        {} as ScheduledEvent,
        env,
        { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
  });
});
