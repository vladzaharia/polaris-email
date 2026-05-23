// useSignInLoopGuard — sessionStorage-backed ring buffer that detects when
// /login is bouncing the operator into the IdP and back without making
// progress.
//
// The previous single-timestamp guard (5s after the last attempt) caught the
// trivial case but missed rapid 3-bounce loops that better-auth produces when
// a stored cookie is stale but technically valid. We track every attempt in
// the last LOOP_WINDOW_MS and trip when at least LOOP_THRESHOLD attempts
// landed inside that window.
//
// Pure helpers are exported so tests can exercise the logic with an
// in-memory Storage shim + vi.useFakeTimers().

const STORAGE_KEY = 'polaris.panel.signinAttempts';
export const LOOP_WINDOW_MS = 30_000;
export const LOOP_THRESHOLD = 3;

export interface LoopGuard {
  /** True when fewer than LOOP_THRESHOLD attempts landed in the last LOOP_WINDOW_MS. */
  shouldAutoSubmit: boolean;
  /** Append a new attempt timestamp. Prunes stale entries as a side effect. */
  recordAttempt: () => void;
  /** Wipe the recorded attempts (used by the "Clear and reload" recovery CTA). */
  reset: () => void;
}

// Pure helpers — testable without a DOM.

function readAttempts(storage: Storage, now: number): number[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
      .filter((ts) => ts > 0 && now - ts < LOOP_WINDOW_MS);
  } catch {
    return [];
  }
}

function writeAttempts(storage: Storage, attempts: number[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(attempts));
  } catch {
    // sessionStorage may be unavailable (private mode, disabled cookies).
    // Loop detection then degrades to "off"; the operator can still drive
    // the flow manually via the Cancel + Try again buttons.
  }
}

/** Returns true when fewer than LOOP_THRESHOLD attempts landed in the window. */
export function shouldAutoSubmit(storage: Storage, now: number = Date.now()): boolean {
  return readAttempts(storage, now).length < LOOP_THRESHOLD;
}

/** Records a new attempt, pruning anything outside the window. */
export function recordAttempt(storage: Storage, now: number = Date.now()): void {
  const fresh = readAttempts(storage, now);
  fresh.push(now);
  writeAttempts(storage, fresh);
}

/** Wipes the stored attempts. */
export function reset(storage: Storage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Same fail-open posture as writeAttempts.
  }
}

/**
 * React-facing hook. Resolves the storage at call time so SSR (which has no
 * `window`) returns a fail-open guard. Re-evaluated on every render —
 * cheap; we read at most a tiny JSON blob.
 */
export function useSignInLoopGuard(): LoopGuard {
  const storage: Storage | null = typeof window === 'undefined' ? null : window.sessionStorage;
  if (!storage) {
    return {
      shouldAutoSubmit: true,
      recordAttempt: () => undefined,
      reset: () => undefined,
    };
  }
  return {
    shouldAutoSubmit: shouldAutoSubmit(storage),
    recordAttempt: () => recordAttempt(storage),
    reset: () => reset(storage),
  };
}
