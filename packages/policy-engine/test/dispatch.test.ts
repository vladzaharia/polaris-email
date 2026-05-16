import { describe, expect, it } from 'vitest';
import { lookupOutcome } from '../src/dispatch.js';
import type { Direction, StreamType, Verdict } from '../src/types.js';

const DIRECTIONS: Direction[] = ['inbound', 'outbound'];
const STREAMS: StreamType[] = ['transactional', 'marketing', 'agent', 'inbound'];
const VERDICTS: Verdict[] = ['pass', 'pass_warn', 'hold', 'block'];

describe('lookupOutcome', () => {
  it('returns a spec for every reachable (direction, stream, verdict) cell', () => {
    // Inbound collapses stream to 'inbound' inside the lookup.
    for (const verdict of VERDICTS) {
      for (const stream of STREAMS) {
        const out = lookupOutcome('inbound', stream, verdict);
        expect(out).toBeDefined();
        expect(out.outcome).toBeTruthy();
      }
    }
    // Outbound has three real streams.
    for (const stream of ['transactional', 'marketing', 'agent'] as const) {
      for (const verdict of VERDICTS) {
        const out = lookupOutcome('outbound', stream, verdict);
        expect(out).toBeDefined();
        expect(out.outcome).toBeTruthy();
      }
    }
  });

  it('inbound block fires a critical alert + drop-with-forensic-row outcome', () => {
    const out = lookupOutcome('inbound', 'inbound', 'block');
    expect(out.outcome).toBe('drop_with_forensic_row');
    expect(out.alert).toBe(true);
    expect(out.alert_severity).toBe('critical');
  });

  it('outbound marketing block credits sender abuse profile', () => {
    const out = lookupOutcome('outbound', 'marketing', 'block');
    expect(out.outcome).toBe('bounce_with_reasons');
    expect(out.credit_sender_abuse).toBe(true);
  });

  it('outbound transactional pass is a clean send with no alert', () => {
    const out = lookupOutcome('outbound', 'transactional', 'pass');
    expect(out.outcome).toBe('send');
    expect(out.alert).toBe(false);
    expect(out.credit_sender_abuse).toBe(false);
  });

  it('any hold queues for moderation with a warn alert', () => {
    for (const direction of DIRECTIONS) {
      const stream: StreamType = direction === 'inbound' ? 'inbound' : 'transactional';
      const out = lookupOutcome(direction, stream, 'hold');
      expect(out.outcome).toBe('queue_for_moderation');
      expect(out.alert).toBe(true);
      expect(out.alert_severity).toBe('warn');
    }
  });
});
