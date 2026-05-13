import { describe, expect, it } from 'vitest';
import { constantTimeEqual, withTimingFloor } from '../src/timing.js';

describe('constantTimeEqual', () => {
  it('returns true for equal arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('returns false for equal-length but different arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('returns false for different-length arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 0]))).toBe(false);
  });

  it('handles empty arrays', () => {
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array([1]))).toBe(false);
  });
});

describe('withTimingFloor', () => {
  it('pads short calls to floor', async () => {
    const start = Date.now();
    const v = await withTimingFloor(80, async () => 'fast');
    const elapsed = Date.now() - start;
    expect(v).toBe('fast');
    expect(elapsed).toBeGreaterThanOrEqual(75); // small slack for setTimeout precision
  });

  it('does not extend slow calls', async () => {
    const start = Date.now();
    const v = await withTimingFloor(20, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return 'slow';
    });
    const elapsed = Date.now() - start;
    expect(v).toBe('slow');
    expect(elapsed).toBeLessThan(120);
  });

  it('rethrows after applying the floor', async () => {
    const start = Date.now();
    await expect(
      withTimingFloor(60, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });
});
