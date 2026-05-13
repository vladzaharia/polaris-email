// Tracing helpers — wrap workers-otel for the cases the modular monolith
// cares about (cross-Worker propagation through queue payloads).
//
// workers-otel as of 2026-05 supports HTTP requests but has gaps for Queue
// consumers and Cron Triggers (I17). We compensate by manually propagating
// `trace_id` through queue payloads (alongside `submission_id` from A9), and
// we synthesize spans for cron handlers from the start/end timestamps.
//
// Until workers-otel is wired in, this module exposes a no-op API so the
// call sites can be added now and switched on later by swapping the
// implementation.

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface Span {
  ctx(): SpanContext;
  setAttribute(key: string, value: string | number | boolean): void;
  end(opts?: { error?: Error }): void;
}

export interface Tracer {
  startSpan(name: string, parent?: SpanContext): Span;
  /** Extract a SpanContext from an inbound payload (queue message, HTTP header). */
  extract(carrier: Record<string, string | undefined>): SpanContext | undefined;
  /** Inject the active span into an outbound payload. */
  inject(span: Span, carrier: Record<string, string>): void;
}

class NoopSpan implements Span {
  constructor(private context: SpanContext) {}
  ctx(): SpanContext {
    return this.context;
  }
  setAttribute(): void {
    /* no-op */
  }
  end(): void {
    /* no-op */
  }
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, parent?: SpanContext): Span {
    return new NoopSpan({
      traceId: parent?.traceId ?? randomHex(32),
      spanId: randomHex(16),
      parentSpanId: parent?.spanId,
    });
  }
  extract(carrier: Record<string, string | undefined>): SpanContext | undefined {
    const tp = carrier['traceparent'];
    if (!tp) return undefined;
    // W3C traceparent: 00-<trace-id>-<span-id>-<flags>
    const parts = tp.split('-');
    if (parts.length !== 4) return undefined;
    return { traceId: parts[1]!, spanId: parts[2]!, parentSpanId: parts[2] };
  }
  inject(span: Span, carrier: Record<string, string>): void {
    const c = span.ctx();
    carrier['traceparent'] = `00-${c.traceId}-${c.spanId}-01`;
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes / 2);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Default tracer instance. Swap to a real workers-otel impl later. */
export const tracer: Tracer = new NoopTracer();
