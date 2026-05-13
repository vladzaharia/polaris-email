import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/logger.js';
import { recordEvent, recordLatency, type AnalyticsBinding } from '../src/analytics.js';
import { NoopTracer } from '../src/tracing.js';

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits a structured JSON line at info level', () => {
    const log = new Logger({ requestId: 'r1', tenantId: 't1' });
    log.info('hello', { count: 5 });
    expect(logSpy).toHaveBeenCalledOnce();
    const rec = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.ctx.requestId).toBe('r1');
    expect(rec.ctx.tenantId).toBe('t1');
    expect(rec.fields.count).toBe(5);
  });

  it('child() merges contexts', () => {
    const parent = new Logger({ requestId: 'r1' });
    const child = parent.child({ tenantId: 't2', domain: 'acme.com' });
    child.warn('hmm');
    const rec = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(rec.ctx.requestId).toBe('r1');
    expect(rec.ctx.tenantId).toBe('t2');
    expect(rec.ctx.domain).toBe('acme.com');
  });

  it('error() captures the Error object as structured fields', () => {
    const log = new Logger();
    log.error('fail', new Error('kaboom'), { ctx: 'x' });
    const rec = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(rec.level).toBe('error');
    expect(rec.err.message).toBe('kaboom');
    expect(rec.err.name).toBe('Error');
    expect(rec.err.stack).toContain('Error');
    expect(rec.fields.ctx).toBe('x');
  });

  it('coerces non-Error throwables to Error shape', () => {
    const log = new Logger();
    log.error('fail', 'just a string');
    const rec = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(rec.err.message).toBe('just a string');
  });
});

describe('analytics', () => {
  class FakeAE implements AnalyticsBinding {
    points: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
    writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void {
      this.points.push(p);
    }
  }

  it('recordEvent writes a counter point with default count 1', () => {
    const ae = new FakeAE();
    recordEvent({ ANALYTICS: ae }, {
      domain: 'acme.com',
      tenantId: 'auth-service',
      eventType: 'sent',
    });
    expect(ae.points).toHaveLength(1);
    expect(ae.points[0]!.blobs).toEqual(['acme.com', 'auth-service', 'sent', '']);
    expect(ae.points[0]!.doubles).toEqual([1]);
    expect(ae.points[0]!.indexes).toEqual(['acme.com']);
  });

  it('recordEvent carries error_class', () => {
    const ae = new FakeAE();
    recordEvent({ ANALYTICS: ae }, {
      domain: 'acme.com',
      tenantId: 't1',
      eventType: 'failed',
      errorClass: 'rate_limited',
      count: 3,
    });
    expect(ae.points[0]!.blobs![3]).toBe('rate_limited');
    expect(ae.points[0]!.doubles).toEqual([3]);
  });

  it('recordLatency writes the latency value', () => {
    const ae = new FakeAE();
    recordLatency({ ANALYTICS: ae }, {
      domain: 'acme.com',
      tenantId: 't1',
      measurement: 'send_ms',
      valueMs: 142.7,
    });
    expect(ae.points[0]!.doubles).toEqual([142.7]);
  });

  it('drops silently when ANALYTICS binding is missing', () => {
    expect(() =>
      recordEvent({}, { domain: 'acme.com', tenantId: 't1', eventType: 'sent' })
    ).not.toThrow();
  });
});

describe('NoopTracer', () => {
  it('startSpan generates a fresh trace+span id when no parent', () => {
    const t = new NoopTracer();
    const s = t.startSpan('op');
    const c = s.ctx();
    expect(c.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('extract parses W3C traceparent', () => {
    const t = new NoopTracer();
    const tp = t.extract({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(tp?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(tp?.spanId).toBe('00f067aa0ba902b7');
  });

  it('extract returns undefined for malformed', () => {
    const t = new NoopTracer();
    expect(t.extract({ traceparent: 'garbage' })).toBeUndefined();
    expect(t.extract({})).toBeUndefined();
  });

  it('inject writes traceparent into the carrier', () => {
    const t = new NoopTracer();
    const s = t.startSpan('op');
    const carrier: Record<string, string> = {};
    t.inject(s, carrier);
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('child span inherits the parent trace id', () => {
    const t = new NoopTracer();
    const parent = t.startSpan('outer');
    const child = t.startSpan('inner', parent.ctx());
    expect(child.ctx().traceId).toBe(parent.ctx().traceId);
    expect(child.ctx().parentSpanId).toBe(parent.ctx().spanId);
    expect(child.ctx().spanId).not.toBe(parent.ctx().spanId);
  });
});
