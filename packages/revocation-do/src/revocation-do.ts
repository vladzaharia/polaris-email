// Per-principal revocation Durable Object (H1 + I2 mitigation).
//
// KV is up to 60 s eventually consistent — a revoked credential could keep
// authenticating for tens of seconds via stale reads. The revocation flag
// must be serializable (single-region, single-writer) for instant effect.
// Durable Objects give us exactly that: every read/write of a given DO
// instance routes to the same colo.
//
// One DO instance per principal_id. The submission daemon's auth path calls
// `revocationCheck()` synchronously on every authentication; the API's
// `/v1/send/raw` re-checks on every accepted message.

export interface RevocationStateResponse {
  revoked: boolean;
  revoked_at: number | null;
}

export interface RevocationHistoryEntry {
  action: 'revoke' | 'unrevoke';
  by: string;
  reason: string;
  ts: number;
}

interface DOStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list?<T>(): Promise<Map<string, T>>;
}

interface DOState {
  storage: DOStorage;
}

export class RevocationDO {
  private state: DOState;

  constructor(state: DOState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    if (method === 'GET' && url.pathname === '/state') {
      return this.handleGetState();
    }
    if (method === 'POST' && url.pathname === '/revoke') {
      return this.handleRevoke(req);
    }
    if (method === 'POST' && url.pathname === '/unrevoke') {
      return this.handleUnrevoke(req);
    }
    if (method === 'GET' && url.pathname === '/history') {
      return this.handleHistory();
    }
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async handleGetState(): Promise<Response> {
    const revokedAt = (await this.state.storage.get<number | null>('revoked_at')) ?? null;
    const body: RevocationStateResponse = {
      revoked: revokedAt !== null,
      revoked_at: revokedAt,
    };
    return Response.json(body);
  }

  private async handleRevoke(req: Request): Promise<Response> {
    const body = await safeJson(req);
    const by = String(body?.by ?? 'unknown');
    const reason = String(body?.reason ?? '');
    const existing = (await this.state.storage.get<number | null>('revoked_at')) ?? null;
    if (existing !== null) {
      // Idempotent: return prior revocation timestamp.
      return Response.json({ revoked: true, revoked_at: existing, idempotent: true });
    }
    const ts = Date.now();
    await this.state.storage.put('revoked_at', ts);
    await this.appendHistory({ action: 'revoke', by, reason, ts });
    return Response.json({ revoked: true, revoked_at: ts, idempotent: false });
  }

  private async handleUnrevoke(req: Request): Promise<Response> {
    const body = await safeJson(req);
    const by = String(body?.by ?? 'unknown');
    const reason = String(body?.reason ?? '');
    await this.state.storage.delete('revoked_at');
    await this.appendHistory({ action: 'unrevoke', by, reason, ts: Date.now() });
    return Response.json({ revoked: false, revoked_at: null });
  }

  private async handleHistory(): Promise<Response> {
    const history = (await this.state.storage.get<RevocationHistoryEntry[]>('history')) ?? [];
    return Response.json(history);
  }

  private async appendHistory(entry: RevocationHistoryEntry): Promise<void> {
    const history = (await this.state.storage.get<RevocationHistoryEntry[]>('history')) ?? [];
    history.push(entry);
    // Cap history at 100 entries to keep DO storage bounded.
    if (history.length > 100) history.splice(0, history.length - 100);
    await this.state.storage.put('history', history);
  }
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
