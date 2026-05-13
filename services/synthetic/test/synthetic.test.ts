import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('synthetic', () => {
  it('does not throw when API_BASE_URL is missing', async () => {
    const env = {
      API_BASE_URL: '',
      ALERT_WEBHOOK: '',
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
