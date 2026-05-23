// Minimal in-memory mocks for D1, KV, R2, Queues. Just enough for unit tests.
import type { Env, OutboundQueueMessage } from '../src/env.js';

export class MockKV {
  private map = new Map<string, { v: string; expiresAt: number | null }>();
  async get(k: string, type?: string): Promise<string | unknown | null> {
    const e = this.map.get(k);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      this.map.delete(k);
      return null;
    }
    if (type === 'json') return JSON.parse(e.v);
    return e.v;
  }
  async put(k: string, v: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
    this.map.set(k, { v, expiresAt });
  }
  async delete(k: string): Promise<void> {
    this.map.delete(k);
  }
  size() {
    return this.map.size;
  }
}

interface TableRow {
  [col: string]: unknown;
}

export class MockD1 {
  tables: Map<string, TableRow[]> = new Map();
  constructor() {
    // Pre-create the canonical (v1) tables used by tests.
    this.tables.set('schema_migrations', []);
    this.tables.set('bootstrap', []);
    this.tables.set('zones', []);
    this.tables.set('mailboxes', []);
    this.tables.set('mail_domains', []);
    this.tables.set('mailbox_senders', []);
    this.tables.set('mailbox_receivers', []);
    this.tables.set('principals', []);
    this.tables.set('api_keys', []);
    this.tables.set('dkim_keys', []);
    this.tables.set('bridges', []);
    this.tables.set('webhook_subs', []);
    this.tables.set('messages', []);
    this.tables.set('message_attempts', []);
    this.tables.set('message_deliveries', []);
    this.tables.set('idempotency_keys', []);
    // Phase L bridge tables (0002_bridge.sql).
    this.tables.set('mailbox_messages_state', []);
    this.tables.set('mailbox_uid_counter', []);
    this.tables.set('mailbox_change_counter', []);
    // Unified credentials (migrations 0002 + 0003).
    this.tables.set('mailbox_credentials', []);
    this.tables.set('audit_log', [
      {
        id: 0,
        actor: 'system',
        action: 'schema.migration',
        target: '0001_init',
        meta: '{"genesis":true}',
        prev_hash: '0'.repeat(64),
        row_hash: '0'.repeat(64),
        at: 0,
      },
    ]);
  }
  prepare(sql: string) {
    return new MockStatement(this, sql);
  }
  // Minimal D1 .batch() shim: execute prepared statements sequentially.
  // Real D1 runs the batch as an implicit transaction; for the in-memory mock
  // there is no concurrency, so sequential execution is observationally
  // equivalent (the first failure throws and aborts the batch).
  async batch<T = unknown>(
    statements: MockStatement[],
  ): Promise<{ results: T[]; meta: MockMeta }[]> {
    const out: { results: T[]; meta: MockMeta }[] = [];
    for (const stmt of statements) {
      out.push((await stmt.run<T>()) as { results: T[]; meta: MockMeta });
    }
    return out;
  }
}

interface MockMeta {
  changes: number;
}

class MockStatement {
  private params: unknown[] = [];
  constructor(
    private db: MockD1,
    private sql: string,
  ) {}
  bind(...params: unknown[]): MockStatement {
    this.params = params;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    const r = await this.run();
    return ((r.results[0] as T) ?? null) as T | null;
  }
  async all<T = unknown>(): Promise<{ results: T[]; meta: MockMeta }> {
    return this.run() as Promise<{ results: T[]; meta: MockMeta }>;
  }
  async run<T = unknown>(): Promise<{ results: T[]; meta: MockMeta }> {
    return executeSql<T>(this.db, this.sql, this.params);
  }
}

function executeSql<T>(
  db: MockD1,
  sql: string,
  params: unknown[],
): { results: T[]; meta: MockMeta } {
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('insert ')) {
    const m = trimmed.match(/insert\s+(?:or\s+(replace|ignore)\s+)?into\s+(\w+)/i);
    if (!m) throw new Error('mock: bad insert ' + trimmed);
    const conflict = m[1]?.toLowerCase();
    const table = m[2]!;
    // support `INSERT INTO tbl (cols) SELECT ?,?,... WHERE (SELECT IFNULL(MAX(id),-1) FROM tbl) = ?`
    // — a CAS form used by audit() to serialise hash-chain writes without a
    // schema-level unique index. The trailing `?` is the expected MAX(id);
    // if it doesn't match, the insert writes zero rows and the caller retries.
    const casColsM = trimmed.match(/insert\s+into\s+\w+\s*\(([^)]+)\)\s*select\s+/i);
    const casWhereM = trimmed.match(
      /select\s+([^]+?)\s+where\s*\(\s*select\s+ifnull\s*\(\s*max\s*\(\s*id\s*\)\s*,\s*-?\d+\s*\)\s+from\s+(\w+)\s*\)\s*=\s*\?\s*$/is,
    );
    if (casColsM && casWhereM) {
      const cols = casColsM[1]!.split(',').map((x) => x.trim());
      const selectList = casWhereM[1]!.split(',').map((x) => x.trim());
      const guardTable = casWhereM[2]!;
      const guardRows = db.tables.get(guardTable) ?? [];
      const observedMax = guardRows.reduce((acc, r) => {
        const n = Number(r['id'] ?? -1);
        return Number.isFinite(n) && n > acc ? n : acc;
      }, -1);
      const expectedMax = params[params.length - 1];
      if (Number(observedMax) !== Number(expectedMax)) {
        return { results: [], meta: { changes: 0 } };
      }
      // Bind the leading params (all but the trailing CAS sentinel) to the
      // SELECT placeholder list in order.
      const rows = db.tables.get(table);
      if (!rows) throw new Error('mock: unknown table ' + table);
      const row: TableRow = {};
      let pi = 0;
      cols.forEach((c, i) => {
        const tok = selectList[i];
        if (tok === undefined) {
          row[c] = undefined;
          return;
        }
        if (tok === '?') row[c] = params[pi++];
        else if (/^-?\d+(\.\d+)?$/.test(tok)) row[c] = Number(tok);
        else if (/^'.*'$/.test(tok)) row[c] = tok.slice(1, -1);
        else if (tok.toLowerCase() === 'null') row[c] = null;
        else row[c] = tok;
      });
      if (table === 'audit_log' && row['id'] === undefined) {
        const maxId = rows.reduce((m, r) => Math.max(m, Number(r['id'] ?? 0)), 0);
        row['id'] = maxId + 1;
      }
      rows.push(row);
      return { results: [], meta: { changes: 1 } };
    }
    const colsM = trimmed.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colsM) throw new Error('mock: insert columns ' + trimmed);
    const cols = colsM[1]!.split(',').map((x) => x.trim());
    // Parse the VALUES (...) tuple so we can resolve positional `?` to a bound
    // param vs an inline literal (number / 'string' / NULL).
    const valsM = trimmed.match(/values\s*\(([^)]*)\)\s*(returning\s+.*)?$/is);
    if (!valsM) throw new Error('mock: insert values ' + trimmed);
    const valTokens = valsM[1]!.split(',').map((v) => v.trim());
    const row: TableRow = {};
    let pi = 0;
    cols.forEach((c, i) => {
      const tok = valTokens[i];
      if (tok === undefined) {
        row[c] = undefined;
        return;
      }
      if (tok === '?' || /^\?\d+$/.test(tok)) {
        // SQLite supports both `?` and numbered `?1`, `?2`, ...
        if (/^\?\d+$/.test(tok)) {
          const idx = Number(tok.slice(1)) - 1;
          row[c] = params[idx];
        } else {
          row[c] = params[pi++];
        }
      } else if (/^-?\d+(\.\d+)?$/.test(tok)) {
        row[c] = Number(tok);
      } else if (/^'.*'$/.test(tok)) {
        row[c] = tok.slice(1, -1);
      } else if (tok.toLowerCase() === 'null') {
        row[c] = null;
      } else {
        row[c] = tok;
      }
    });
    const rows = db.tables.get(table);
    if (!rows) throw new Error('mock: unknown table ' + table);
    // Crude UNIQUE/PK handling: id column conflicts.
    if (conflict !== 'ignore' && conflict !== 'replace') {
      // Detect simple unique columns
      const uniqueCols = ['id', 'address', 'domain', 'name', 'username', 'cf_zone_id'];
      for (const u of uniqueCols) {
        if (row[u] != null && rows.some((r) => r[u] != null && r[u] === row[u])) {
          throw new Error(`mock: UNIQUE constraint failed (${table}.${u})`);
        }
      }
    } else if (conflict === 'replace') {
      const idx = rows.findIndex((r) => r['id'] !== undefined && r['id'] === row['id']);
      if (idx >= 0) rows.splice(idx, 1);
    } else if (conflict === 'ignore') {
      if (rows.some((r) => r['id'] !== undefined && r['id'] === row['id'])) {
        return { results: [], meta: { changes: 0 } };
      }
      // Composite PK on idempotency_keys (principal_id, key) per migration
      // 0004. INSERT OR IGNORE must observe the composite uniqueness; this
      // is what makes the pipeline's tryClaim() return `first: false` on a
      // replay.
      if (table === 'idempotency_keys') {
        if (
          rows.some(
            (r) =>
              r['principal_id'] != null &&
              r['key'] != null &&
              r['principal_id'] === row['principal_id'] &&
              r['key'] === row['key'],
          )
        ) {
          return { results: [], meta: { changes: 0 } };
        }
      }
    }
    // For audit_log auto-increment, assign id if not given
    if (table === 'audit_log' && row['id'] === undefined) {
      const maxId = rows.reduce((m, r) => Math.max(m, Number(r['id'] ?? 0)), 0);
      row['id'] = maxId + 1;
    }
    if (table === 'api_key_usage' && row['id'] === undefined) {
      const maxId = rows.reduce((m, r) => Math.max(m, Number(r['id'] ?? 0)), 0);
      row['id'] = maxId + 1;
    }
    rows.push(row);
    // RETURNING support: parse the captured fragment, return the named cols.
    const retMatch = trimmed.match(/returning\s+(.+)$/is);
    if (retMatch) {
      const colsRet = retMatch[1]!.split(',').map((s) => s.trim());
      const out: TableRow = {};
      for (const col of colsRet) out[col] = row[col];
      return { results: [out as unknown as T], meta: { changes: 1 } };
    }
    return { results: [], meta: { changes: 1 } };
  }
  if (lower.startsWith('update ')) {
    // 4a.3: support `UPDATE ... RETURNING <cols>` so the new atomic counter
    // allocation paths in lib/state.ts and packages/pipeline can run under
    // the in-memory mock. We strip the RETURNING tail before the WHERE
    // parser sees it, then synthesise the result rows from the mutated
    // values after the SET ops apply.
    const retM = trimmed.match(/^([\s\S]+?)\s+returning\s+(.+)$/i);
    const updateBody = retM ? retM[1]! : trimmed;
    const returningCols = retM
      ? retM[2]!.split(',').map((c) => {
          const aliasM = c.trim().match(/^([\w()+\-*/\s]+?)(?:\s+as\s+(\w+))?$/i);
          if (aliasM) {
            const expr = aliasM[1]!.trim();
            const alias = aliasM[2]?.trim() ?? expr;
            return { expr, alias };
          }
          return { expr: c.trim(), alias: c.trim() };
        })
      : [];
    const m = updateBody.match(/update\s+(\w+)\s+set\s+(.+?)\s+where\s+(.+)$/is);
    if (!m) throw new Error('mock: bad update ' + trimmed);
    const table = m[1]!;
    const setClause = m[2]!;
    const whereClause = m[3]!;
    const rows = db.tables.get(table);
    if (!rows) throw new Error('mock: unknown table ' + table);
    // Bound parameters fill SET first, then WHERE
    let pi = 0;
    interface SetOp {
      col: string;
      idx: number | null;
      literal?: unknown;
      // 4a.3: support `col = col + 1` arithmetic for atomic counter bumps.
      arith?: { src: string; delta: number };
    }
    const setOps: SetOp[] = [];
    for (const part of setClause.split(',')) {
      const setM = part.trim().match(/^(\w+)\s*=\s*(.+)$/);
      if (!setM) continue;
      const col = setM[1]!;
      const val = setM[2]!.trim();
      const numMatch = val.match(/^\?(\d+)$/);
      const arithMatch = val.match(/^(\w+)\s*\+\s*(\d+)$/);
      if (val === '?') {
        setOps.push({ col, idx: pi++ });
      } else if (numMatch) {
        setOps.push({ col, idx: Number(numMatch[1]) - 1 });
      } else if (arithMatch) {
        setOps.push({
          col,
          idx: null,
          arith: { src: arithMatch[1]!, delta: Number(arithMatch[2]) },
        });
      } else if (rows.length && val.match(/^[A-Za-z_]\w*$/) && val in rows[0]!) {
        // column-to-column copy (e.g. imap_pw_bcrypt_prev = imap_pw_bcrypt)
        setOps.push({ col, idx: null, literal: val });
      } else if (val.toLowerCase() === 'null') {
        setOps.push({ col, idx: null, literal: null });
      } else if (val.startsWith("'") && val.endsWith("'")) {
        setOps.push({ col, idx: null, literal: val.slice(1, -1) });
      } else {
        setOps.push({ col, idx: null, literal: val });
      }
    }
    // WHERE: support patterns we use (col = ?, col = ?N, col = literal, IS NULL, etc.)
    const whereParams = params.slice(pi);
    const whereMatches = (row: TableRow): boolean => {
      let wp = 0;
      for (const cond of whereClause.split(/\s+and\s+/i)) {
        const cTrim = cond.trim();
        const numMatch = cTrim.match(/^(\w+)\s*=\s*\?(\d+)$/);
        const numLitMatch = cTrim.match(/^(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/);
        const cm =
          cTrim.match(/^(\w+)\s*=\s*\?$/) ??
          cTrim.match(/^(\w+)\s*<>\s*'([^']+)'$/) ??
          cTrim.match(/^(\w+)\s+IS NOT NULL$/i) ??
          cTrim.match(/^(\w+)\s+IS NULL$/i) ??
          cTrim.match(/^(\w+)\s*=\s*'([^']+)'$/);
        if (!cm && !numMatch && !numLitMatch) throw new Error('mock: where part ' + cond);
        if (numMatch) {
          const col = numMatch[1]!;
          const want = params[Number(numMatch[2]) - 1];
          if (row[col] != want) return false;
          continue;
        }
        if (numLitMatch) {
          const col = numLitMatch[1]!;
          const want = Number(numLitMatch[2]);
          if (Number(row[col]) != want) return false;
          continue;
        }
        const col = cm![1]!;
        if (/IS NOT NULL/i.test(cTrim)) {
          if (row[col] == null) return false;
        } else if (/IS NULL/i.test(cTrim)) {
          if (row[col] != null) return false;
        } else if (cm![2] !== undefined) {
          const lit = cm![2];
          if (cTrim.includes('<>')) {
            if (row[col] == lit) return false;
          } else {
            if (row[col] != lit) return false;
          }
        } else {
          const wantedParam = whereParams[wp++];
          if (row[col] != wantedParam) return false;
        }
      }
      return true;
    };
    let changes = 0;
    const returningRows: TableRow[] = [];
    for (const row of rows) {
      if (whereMatches(row)) {
        for (const s of setOps) {
          if (s.idx != null) row[s.col] = params[s.idx];
          else if (s.arith) {
            const cur = Number(row[s.arith.src] ?? 0);
            row[s.col] = cur + s.arith.delta;
          } else if (typeof s.literal === 'string' && s.literal in row) {
            row[s.col] = row[s.literal];
          } else {
            row[s.col] = s.literal;
          }
        }
        changes++;
        if (returningCols.length) {
          const out: TableRow = {};
          for (const { expr, alias } of returningCols) {
            // Support bare column names; arithmetic forms are not used by
            // current callers but degrade gracefully.
            if (expr in row) {
              out[alias] = row[expr];
            } else {
              const arith = expr.match(/^(\w+)\s*([+-])\s*(\d+)$/);
              if (arith && arith[1]! in row) {
                const cur = Number(row[arith[1]!] ?? 0);
                out[alias] = arith[2] === '+' ? cur + Number(arith[3]) : cur - Number(arith[3]);
              } else {
                out[alias] = null;
              }
            }
          }
          returningRows.push(out);
        }
      }
    }
    return { results: returningRows as T[], meta: { changes } };
  }
  if (lower.startsWith('select ')) {
    // Very limited: extract table and where eq params.
    const m = trimmed.match(/from\s+(\w+)/i);
    if (!m) throw new Error('mock: bad select ' + trimmed);
    const table = m[1]!;
    const rows = db.tables.get(table) ?? [];
    let filtered = rows;
    const whereM = trimmed.match(/where\s+(.+?)(?:\s+order\s+by|\s+limit|$)/is);
    if (whereM) {
      const conds = whereM[1]!.split(/\s+and\s+/i);
      let pi = 0;
      filtered = filtered.filter((row) => {
        let wp = pi;
        for (const cond of conds) {
          const t = cond.trim();
          if (/^(\w+)\s+IS\s+NULL$/i.test(t)) {
            const cm = t.match(/^(\w+)\s+IS\s+NULL$/i)!;
            if (row[cm[1]!] != null) return false;
          } else if (/^(\w+)\s+IS\s+NOT\s+NULL$/i.test(t)) {
            const cm = t.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i)!;
            if (row[cm[1]!] == null) return false;
          } else if (/^\(\s*[^)]+\s*\)$/.test(t)) {
            // parenthesised disjunction — accept if any param matches by simple equality
            const inner = t.slice(1, -1);
            const ors = inner.split(/\s+or\s+/i);
            let any = false;
            for (const orC of ors) {
              const eq = orC.trim().match(/^(\w+)\s*=\s*'([^']+)'$/);
              if (eq && row[eq[1]!] == eq[2]) {
                any = true;
                break;
              }
            }
            if (!any) return false;
          } else {
            const eq = t.match(/^(\w+)\s*=\s*\?$/);
            const eqN = t.match(/^(\w+)\s*=\s*\?(\d+)$/);
            const eqLit = t.match(/^(\w+)\s*=\s*'([^']+)'$/);
            const neq = t.match(/^(\w+)\s*<>\s*'([^']+)'$/);
            const like = t.match(/^(\w+)\s+LIKE\s+\?$/i);
            const likeN = t.match(/^(\w+)\s+LIKE\s+\?(\d+)$/i);
            const gte = t.match(/^(\w+)\s*>=\s*\?(\d*)$/);
            const lte = t.match(/^(\w+)\s*<=\s*\?(\d*)$/);
            const gt = t.match(/^(\w+)\s*>\s*\?(\d*)$/);
            const lt = t.match(/^(\w+)\s*<\s*\?(\d*)$/);
            if (eq) {
              if (row[eq[1]!] != params[wp++]) return false;
            } else if (eqN) {
              const idx = Number(eqN[2]) - 1;
              if (row[eqN[1]!] != params[idx]) return false;
            } else if (eqLit) {
              if (row[eqLit[1]!] != eqLit[2]) return false;
            } else if (neq) {
              if (row[neq[1]!] == neq[2]) return false;
            } else if (like) {
              const v = params[wp++];
              const pat = String(v ?? '').replace(/%/g, '');
              if (!String(row[like[1]!] ?? '').includes(pat)) return false;
            } else if (likeN) {
              const idx = Number(likeN[2]) - 1;
              const pat = String(params[idx] ?? '').replace(/%/g, '');
              if (!String(row[likeN[1]!] ?? '').includes(pat)) return false;
            } else if (gte || lte || gt || lt) {
              const m = (gte ?? lte ?? gt ?? lt)!;
              const col = m[1]!;
              const placeholderIdx = m[2];
              const want = placeholderIdx ? params[Number(placeholderIdx) - 1] : params[wp++];
              const have = row[col];
              if (have == null) return false;
              // Numeric comparison if both sides look numeric; otherwise string-collate.
              let cmp: number;
              if (typeof have === 'number' || typeof want === 'number') {
                cmp = Number(have) - Number(want);
              } else {
                cmp = String(have).localeCompare(String(want));
              }
              if (gte && cmp < 0) return false;
              if (lte && cmp > 0) return false;
              if (gt && cmp <= 0) return false;
              if (lt && cmp >= 0) return false;
            } else {
              throw new Error('mock: where cond ' + t);
            }
          }
        }
        pi = wp;
        return true;
      });
    }
    if (/order\s+by\s+id\s+desc/i.test(trimmed)) {
      filtered = [...filtered].sort((a, b) => Number(b['id']) - Number(a['id']));
    }
    if (/order\s+by\s+created_at\s+desc/i.test(trimmed)) {
      filtered = [...filtered].sort((a, b) =>
        String(b['created_at']).localeCompare(String(a['created_at'])),
      );
    }
    if (/order\s+by\s+id\s+asc/i.test(trimmed)) {
      filtered = [...filtered].sort((a, b) => Number(a['id']) - Number(b['id']));
    }
    if (/order\s+by\s+change_id\s+asc/i.test(trimmed)) {
      filtered = [...filtered].sort((a, b) => Number(a['change_id']) - Number(b['change_id']));
    }
    if (/order\s+by\s+created_at\s+asc/i.test(trimmed)) {
      filtered = [...filtered].sort((a, b) =>
        String(a['created_at']).localeCompare(String(b['created_at'])),
      );
    }
    const offsetM = trimmed.match(/offset\s+(\d+)/i);
    const offset = offsetM ? Number(offsetM[1]) : 0;
    if (offset > 0) filtered = filtered.slice(offset);
    const limitM = trimmed.match(/limit\s+(\d+)/i);
    const limit = limitM ? Number(limitM[1]) : undefined;
    if (limit != null) filtered = filtered.slice(0, limit);
    return { results: filtered as T[], meta: { changes: 0 } };
  }
  if (lower.startsWith('delete from ')) {
    const m = trimmed.match(/delete\s+from\s+(\w+)(?:\s+where\s+(.+))?$/is);
    if (!m) return { results: [], meta: { changes: 0 } };
    const table = m[1]!;
    const whereClause = m[2];
    const rows = db.tables.get(table);
    if (!rows) return { results: [], meta: { changes: 0 } };
    if (!whereClause) {
      const n = rows.length;
      rows.length = 0;
      return { results: [], meta: { changes: n } };
    }
    const matchRow = (row: TableRow): boolean => {
      let pi = 0;
      for (const cond of whereClause.split(/\s+and\s+/i)) {
        const t = cond.trim();
        const eq = t.match(/^(\w+)\s*=\s*\?$/);
        const eqN = t.match(/^(\w+)\s*=\s*\?(\d+)$/);
        const isNull = t.match(/^(\w+)\s+IS\s+NULL$/i);
        const isNotNull = t.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
        const lt = t.match(/^(\w+)\s*<\s*\?$/);
        if (eq) {
          if (row[eq[1]!] != params[pi++]) return false;
        } else if (eqN) {
          const idx = Number(eqN[2]) - 1;
          if (row[eqN[1]!] != params[idx]) return false;
        } else if (isNull) {
          if (row[isNull[1]!] != null) return false;
        } else if (isNotNull) {
          if (row[isNotNull[1]!] == null) return false;
        } else if (lt) {
          const want = params[pi++];
          const have = row[lt[1]!];
          if (have == null) return false;
          if (String(have).localeCompare(String(want)) >= 0) return false;
        } else {
          // Unsupported condition shape — fail closed (no delete).
          return false;
        }
      }
      return true;
    };
    let changes = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (matchRow(rows[i]!)) {
        rows.splice(i, 1);
        changes++;
      }
    }
    return { results: [], meta: { changes } };
  }
  throw new Error('mock: unsupported sql: ' + trimmed.slice(0, 120));
}

export class MockR2 {
  private map = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
  async put(
    key: string,
    body: string | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.map.set(key, {
      body: bytes,
      meta: { contentType: opts?.httpMetadata?.contentType ?? '' },
    });
    return { key } as unknown;
  }
  async get(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    const bytes = e.body;
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => buf,
    } as unknown;
  }
  async head(key: string) {
    return this.map.has(key) ? ({} as unknown) : null;
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  size() {
    return this.map.size;
  }
}

export class MockQueue<T> {
  sent: T[] = [];
  async send(msg: T) {
    this.sent.push(msg);
  }
  async sendBatch(msgs: { body: T }[]) {
    for (const m of msgs) this.sent.push(m.body);
  }
}

export function mkEnv(overrides: Partial<Env> = {}): Env {
  const env = {
    DB: new MockD1() as unknown as D1Database,
    R2: new MockR2() as unknown as R2Bucket,
    KV_NONCE: new MockKV() as unknown as KVNamespace,
    KV_IDEMPOTENCY: new MockKV() as unknown as KVNamespace,
    KV_RATE_LIMIT: new MockKV() as unknown as KVNamespace,
    KV_KEY_CACHE: new MockKV() as unknown as KVNamespace,
    KV_REVOCATIONS: new MockKV() as unknown as KVNamespace,
    OUTBOUND_QUEUE: new MockQueue<OutboundQueueMessage>() as unknown as Queue<OutboundQueueMessage>,
    API_BASE_URL: 'https://polaris-mail-api.workers.dev',
    R2_PUBLIC_HOST: 'r2.mail.plrs.im',
    POLARIS_SECRET_A: 'test-control-plane-secret',
    ARGON2_PEPPER: 'test-pepper',
    ...overrides,
  };
  return env as unknown as Env;
}
