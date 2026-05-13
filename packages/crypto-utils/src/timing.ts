// Timing helpers for H5/H7-style guarantees.

/** Constant-time byte comparison; no early exit on length-mismatched inputs. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // We still must read both inputs; if lengths differ we walk the longer one
  // and force a non-equal accumulator, so total work is bounded by max(|a|,|b|).
  const la = a.length;
  const lb = b.length;
  const n = Math.max(la, lb);
  let acc = la ^ lb; // nonzero iff lengths differ
  for (let i = 0; i < n; i++) {
    const av = i < la ? (a[i] ?? 0) : 0;
    const bv = i < lb ? (b[i] ?? 0) : 0;
    acc |= av ^ bv;
  }
  return acc === 0;
}

/**
 * Pad the elapsed time of `fn` to at least `minMs`. Used for H7-style timing
 * floors on credential-validation paths. Errors are still rethrown after the
 * floor has elapsed.
 */
export async function withTimingFloor<T>(
  minMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let value: T;
  let err: unknown;
  try {
    value = await fn();
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - start;
  const remaining = minMs - elapsed;
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
  if (err !== undefined) throw err;
  // value is assigned in the success branch
  return value!;
}
