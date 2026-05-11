import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('janitor', () => {
  it('runs and completes when DB is empty', async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async all() {
              if (sql.includes('SELECT m.id')) return { results: [], meta: {} };
              return { results: [], meta: {} };
            },
            async run() {
              return { results: [], meta: { changes: 0 } };
            },
          };
        },
      } as unknown as D1Database,
      R2: {
        async delete() {},
      } as unknown as R2Bucket,
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
