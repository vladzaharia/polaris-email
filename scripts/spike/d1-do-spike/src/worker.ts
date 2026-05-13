export interface Env {
  CONTROL: D1Database;
  MESSAGES: D1Database;
  DELIVERY: DurableObjectNamespace;
}

export class DeliveryDO {
  state: DurableObjectState;
  sql: SqlStorage | undefined;
  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = (state.storage as { sql?: SqlStorage }).sql;
  }
  async fetch(): Promise<Response> {
    if (!this.sql) {
      return Response.json({ ok: false, error: "do_sqlite_unavailable" });
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS k (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("INSERT OR REPLACE INTO k (k, v) VALUES (?, ?)", "spike", String(Date.now()));
    const row = this.sql.exec("SELECT v FROM k WHERE k = 'spike'").one();
    return Response.json({ ok: true, value: row?.v });
  }
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const t0 = Date.now();
    const [control, messages] = await Promise.allSettled([
      env.CONTROL.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
      env.MESSAGES.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
    ]);
    const d1Ms = Date.now() - t0;

    const t1 = Date.now();
    let doResult: unknown = null;
    let doError: string | null = null;
    try {
      const id = env.DELIVERY.idFromName("spike");
      const stub = env.DELIVERY.get(id);
      const resp = await stub.fetch("http://do/");
      doResult = await resp.json();
    } catch (e) {
      doError = (e as Error).message;
    }
    const doMs = Date.now() - t1;

    return Response.json({
      control_d1: control.status === "fulfilled" ? "ok" : "error",
      messages_d1: messages.status === "fulfilled" ? "ok" : "error",
      d1_ms: d1Ms,
      do_sqlite: doError ? "error" : (doResult as { ok?: boolean })?.ok ? "ok" : "unavailable",
      do_sqlite_ms: doMs,
      do_result: doResult,
      do_error: doError,
    });
  },
};
