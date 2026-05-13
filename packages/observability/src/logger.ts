// Structured Worker logger — emits JSON-Line records consumed by Logpush.
//
// Logpush (Cloudflare's batched log shipper) writes to R2 every 5 minutes by
// default. For real-time tail in development, point a Tail Worker at the same
// Worker (configured via wrangler.toml `[[tail_consumers]]`) which mirrors
// each `console.log()` to a debug Worker. We log only structured records so
// either consumer can parse the stream uniformly.

export interface LogContext {
  /** Per-request correlation id; mirrors `c.var.requestId` from Hono. */
  requestId?: string;
  /** Trace id from workers-otel propagation. */
  traceId?: string;
  /** Optional submission_id for SMTP path. */
  submissionId?: string;
  /** Optional daemon_id when the call is from /v1/bridge/* */
  daemonId?: string;
  /** Tenant being acted on (when known). */
  tenantId?: string;
  /** Domain being acted on (when known). */
  domain?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: LogContext;
  err?: { name: string; message: string; stack?: string };
  /** Arbitrary structured fields. Avoid PII. */
  fields?: Record<string, unknown>;
}

export class Logger {
  constructor(private base: LogContext = {}) {}

  child(extra: LogContext): Logger {
    return new Logger({ ...this.base, ...extra });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields, err);
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>, err?: unknown): void {
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      ctx: this.base,
      fields,
    };
    if (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      rec.err = { name: e.name, message: e.message, stack: e.stack };
    }
    // console.log emits to both Logpush (after batching) and any attached
    // Tail Worker (real-time).
    console.log(JSON.stringify(rec));
  }
}
