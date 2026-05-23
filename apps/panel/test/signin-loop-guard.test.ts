import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_THRESHOLD,
  LOOP_WINDOW_MS,
  recordAttempt,
  reset,
  shouldAutoSubmit,
} from '../src/client/hooks/useSignInLoopGuard.js';

// In-memory Storage shim — matches the Web Storage interface enough that
// the hook's pure helpers can drive it without a DOM.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) ?? null) : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

describe('useSignInLoopGuard helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in the "auto-submit allowed" state', () => {
    const s = makeStorage();
    expect(shouldAutoSubmit(s)).toBe(true);
  });

  it('trips after LOOP_THRESHOLD attempts inside the window', () => {
    const s = makeStorage();
    for (let i = 0; i < LOOP_THRESHOLD - 1; i++) {
      recordAttempt(s);
      vi.advanceTimersByTime(1_000);
    }
    expect(shouldAutoSubmit(s)).toBe(true);
    recordAttempt(s);
    expect(shouldAutoSubmit(s)).toBe(false);
  });

  it('does NOT trip when the same number of attempts are spread outside the window', () => {
    const s = makeStorage();
    // LOOP_THRESHOLD attempts but spaced so only the most recent is in-window.
    for (let i = 0; i < LOOP_THRESHOLD; i++) {
      recordAttempt(s);
      vi.advanceTimersByTime(LOOP_WINDOW_MS + 1);
    }
    expect(shouldAutoSubmit(s)).toBe(true);
  });

  it('prunes stale entries on read', () => {
    const s = makeStorage();
    recordAttempt(s);
    recordAttempt(s);
    recordAttempt(s);
    expect(shouldAutoSubmit(s)).toBe(false);
    vi.advanceTimersByTime(LOOP_WINDOW_MS + 1);
    // All entries should be pruned now.
    expect(shouldAutoSubmit(s)).toBe(true);
    // And the next recordAttempt should write a fresh single-entry buffer.
    recordAttempt(s);
    const raw = JSON.parse(s.getItem('polaris.panel.signinAttempts') ?? '[]') as number[];
    expect(raw.length).toBe(1);
  });

  it('reset() clears the buffer', () => {
    const s = makeStorage();
    recordAttempt(s);
    recordAttempt(s);
    recordAttempt(s);
    expect(shouldAutoSubmit(s)).toBe(false);
    reset(s);
    expect(shouldAutoSubmit(s)).toBe(true);
    expect(s.getItem('polaris.panel.signinAttempts')).toBeNull();
  });

  it('treats malformed storage as empty', () => {
    const s = makeStorage();
    s.setItem('polaris.panel.signinAttempts', 'not-json');
    expect(shouldAutoSubmit(s)).toBe(true);
    s.setItem('polaris.panel.signinAttempts', '{"not":"an array"}');
    expect(shouldAutoSubmit(s)).toBe(true);
  });

  it('ignores non-numeric or out-of-window entries when reading', () => {
    const s = makeStorage();
    const now = Date.now();
    s.setItem(
      'polaris.panel.signinAttempts',
      JSON.stringify([now, now - LOOP_WINDOW_MS - 1, 'not-a-number', null, now - 100]),
    );
    // Only the 2 in-window numeric entries should count → still allows auto.
    expect(shouldAutoSubmit(s)).toBe(true);
  });
});
