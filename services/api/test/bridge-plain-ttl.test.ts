// Unit tests for the self-healing plaintext-cache TTL math in
// bridge-auth.ts: the availability EWMA + the tenure/availability → TTL
// mapping that lets a long-lived, reliable bridge survive a longer
// outage before the api forgets its key.
import { describe, expect, it } from 'vitest';
import {
  updateAvailabilityEwma,
  bridgePlainTtlSeconds,
  FLOOR_S,
  CEIL_S,
  TENURE_FULL_MS,
  GAP_GRACE_MS,
} from '../src/bridge-auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('updateAvailabilityEwma', () => {
  it('returns 1.0 on the first heartbeat (prev === null)', () => {
    expect(updateAvailabilityEwma(null, 60_000)).toBe(1.0);
  });

  it('keeps a normal-cadence beat at ~1.0', () => {
    // A 60s gap is well under GAP_GRACE_MS, so uptimeFrac === 1 and the
    // EWMA stays pinned at the top.
    expect(updateAvailabilityEwma(1.0, 60_000)).toBeCloseTo(1.0, 6);
  });

  it('a gap at the grace boundary still counts as fully up', () => {
    expect(updateAvailabilityEwma(1.0, GAP_GRACE_MS)).toBeCloseTo(1.0, 6);
  });

  it('a multi-day silence pulls the EWMA below 1', () => {
    // 7-day gap: only the first 10min counted as "up", so uptimeFrac is
    // tiny and alpha (exp(-7d/30d) ≈ 0.79) can't hold the prior at 1.
    const next = updateAvailabilityEwma(1.0, 7 * DAY_MS);
    expect(next).toBeLessThan(1.0);
    expect(next).toBeGreaterThan(0);
  });

  it('clamps into [0,1] and treats non-positive gaps as a no-op', () => {
    expect(updateAvailabilityEwma(0.5, 0)).toBe(0.5);
    expect(updateAvailabilityEwma(0.5, -1000)).toBe(0.5);
    expect(updateAvailabilityEwma(2.0, 60_000)).toBeLessThanOrEqual(1);
    expect(updateAvailabilityEwma(-1.0, 60_000)).toBeGreaterThanOrEqual(0);
  });

  it('repeated long outages drive the EWMA steadily down', () => {
    let ewma = 1.0;
    for (let i = 0; i < 5; i++) ewma = updateAvailabilityEwma(ewma, 3 * DAY_MS);
    expect(ewma).toBeLessThan(0.7);
  });
});

describe('bridgePlainTtlSeconds', () => {
  it('a fresh bridge gets the floor regardless of EWMA', () => {
    expect(bridgePlainTtlSeconds(1.0, 0)).toBe(FLOOR_S);
    expect(bridgePlainTtlSeconds(0.3, 0)).toBe(FLOOR_S);
  });

  it('a 30d bridge at full availability earns the ceiling', () => {
    expect(bridgePlainTtlSeconds(1.0, TENURE_FULL_MS)).toBe(CEIL_S);
    // Tenure beyond 30d saturates — no overshoot past the ceiling.
    expect(bridgePlainTtlSeconds(1.0, 10 * TENURE_FULL_MS)).toBe(CEIL_S);
  });

  it('a degraded EWMA lands strictly between floor and ceiling at full tenure', () => {
    const ttl = bridgePlainTtlSeconds(0.5, TENURE_FULL_MS);
    expect(ttl).toBeGreaterThan(FLOOR_S);
    expect(ttl).toBeLessThan(CEIL_S);
    // factor = 0.5*1 ⇒ exactly halfway.
    expect(ttl).toBe(Math.round(FLOOR_S + (CEIL_S - FLOOR_S) * 0.5));
  });

  it('TTL grows monotonically with tenure at fixed availability', () => {
    const ttls = [0, 5, 10, 20, 30].map((d) => bridgePlainTtlSeconds(1.0, d * DAY_MS));
    for (let i = 1; i < ttls.length; i++) expect(ttls[i]).toBeGreaterThanOrEqual(ttls[i - 1]!);
  });

  it('clamps negative tenure to the floor', () => {
    expect(bridgePlainTtlSeconds(1.0, -DAY_MS)).toBe(FLOOR_S);
  });
});
