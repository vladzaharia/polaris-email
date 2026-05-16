import { describe, expect, it, vi } from 'vitest';
import { evaluatePolicy } from '../src/engine.js';
import { DEFAULT_BANDS } from '../src/types.js';
import type { D1, D1Stmt, KV, AiBinding, PolicyInput, PolicyConfig } from '../src/types.js';

function makeStubDb(rows: Record<string, unknown> = {}): D1 {
  const stmt: D1Stmt = {
    bind: () => stmt,
    first: async <T>() => null as T | null,
    all: async <T>() => ({ results: [] as T[] }),
    run: async () => undefined,
  };
  return {
    prepare: (sql: string) => {
      const hit = rows[sql];
      if (hit !== undefined) {
        return {
          ...stmt,
          first: async <T>() => hit as T,
        };
      }
      return stmt;
    },
  };
}

function makeStubKv(values: Record<string, string> = {}): KV {
  return {
    get: async (k: string) => values[k] ?? null,
    put: async () => undefined,
  };
}

function baseInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  const env = {
    DB: makeStubDb(),
    KV: makeStubKv(),
    ...overrides.env,
  };
  return {
    direction: 'inbound',
    stream_type: 'inbound',
    sender: { address: 'sender@example.com' },
    receiver: { address: 'rcpt@plrs.im', mailbox_id: 'mb1' },
    message: {
      raw_headers: 'From: sender@example.com\nTo: rcpt@plrs.im\nSubject: hello',
      headers: {
        from: 'sender@example.com',
        to: 'rcpt@plrs.im',
        subject: 'hello',
      },
      body_preview: 'Just saying hi.',
      content_types: ['text/plain'],
      attachment_filenames: [],
    },
    auth: { dmarc: 'pass', spf: 'pass', dkim: { result: 'pass', signing_domain: 'example.com' } },
    env,
    config: { bands: DEFAULT_BANDS, weights: {} } as PolicyConfig,
    ...overrides,
  };
}

describe('evaluatePolicy — happy paths', () => {
  it('clean inbound legitimate message lands in pass band', async () => {
    const decision = await evaluatePolicy(baseInput());
    expect(decision.verdict).toBe('pass');
    expect(decision.band).toBe('pass');
    expect(decision.total_score).toBeGreaterThanOrEqual(0);
    expect(decision.llm.invoked).toBe(false);
  });

  it('clean outbound transactional lands in pass', async () => {
    const decision = await evaluatePolicy(
      baseInput({
        direction: 'outbound',
        stream_type: 'transactional',
        sender: {
          address: 'app@plrs.im',
          mailbox_id: 'mb1',
          domain_id: 'dom1',
          dmarc_promotion_state: 'reject',
        },
        receiver: { address: 'customer@external.com' },
      }),
    );
    expect(decision.verdict).toBe('pass');
  });
});

describe('evaluatePolicy — heuristic stacking', () => {
  it('multiple negative signals stack to land in hold or block', async () => {
    const decision = await evaluatePolicy(
      baseInput({
        message: {
          raw_headers:
            'From: "PayPal Security" <attacker@evil.com>\nSubject: URGENT verify your account',
          headers: {
            from: '"PayPal Security" <attacker@evil.com>',
            subject: 'URGENT verify your account',
            'reply-to': 'support@something-else.com',
          },
          body_preview: '<a href="http://attacker.com/login">https://paypal.com/login</a>',
          content_types: ['text/html'],
          attachment_filenames: ['invoice.pdf.exe'],
          html_only: true,
        },
        auth: { dmarc: 'fail', spf: 'fail', dkim: { result: 'fail' }, dmarc_policy: 'reject' },
      }),
    );
    expect(['hold', 'block']).toContain(decision.verdict);
    // The reason vector must have multiple stacked signals — engine should
    // never fail-closed silently.
    expect(decision.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluatePolicy — LLM tiebreaker (inbound, uncertain band)', () => {
  it('phishing label with high confidence flips verdict to block', async () => {
    const ai: AiBinding = {
      run: vi.fn().mockResolvedValue({
        response: JSON.stringify({ label: 'phishing', confidence: 0.9, rationale: 'looks bad' }),
      }),
    };
    // Craft an uncertain-band input. Use `example.net` (no typosquat collision)
    // + DKIM fail (-5) + phishy subject (-3) = -8. Add Message-ID so the
    // missing-mid heuristic (-2) doesn't push us into hold band.
    const decision = await evaluatePolicy(
      baseInput({
        env: {
          DB: makeStubDb(),
          KV: makeStubKv(),
          AI: ai,
        },
        message: {
          raw_headers:
            'From: a@example.net\nMessage-ID: <m1@example.net>\nSubject: URGENT verify your account',
          headers: {
            from: 'a@example.net',
            'message-id': '<m1@example.net>',
            subject: 'URGENT verify your account',
          },
          body_preview: 'click here',
          content_types: [],
          attachment_filenames: [],
        },
        auth: { dkim: { result: 'fail' }, dmarc: 'none', spf: 'none' },
      }),
    );
    // tiebreaker delta -20 added to heuristic -8 = -28, lands in block_decisive band
    expect(decision.band).toBe('block_decisive');
    expect(decision.llm.invoked).toBe(true);
    expect(decision.llm.label).toBe('phishing');
    expect(decision.verdict).toBe('block');
  });

  it('LLM error in uncertain band falls back to hold (admin tiebreaker)', async () => {
    const ai: AiBinding = {
      run: vi.fn().mockRejectedValue(new Error('inference failed')),
    };
    const decision = await evaluatePolicy(
      baseInput({
        env: {
          DB: makeStubDb(),
          KV: makeStubKv(),
          AI: ai,
        },
        message: {
          raw_headers:
            'From: a@example.net\nMessage-ID: <m1@example.net>\nSubject: URGENT verify your account',
          headers: {
            from: 'a@example.net',
            'message-id': '<m1@example.net>',
            subject: 'URGENT verify your account',
          },
          body_preview: 'click here',
          content_types: [],
          attachment_filenames: [],
        },
        auth: { dkim: { result: 'fail' } },
      }),
    );
    expect(decision.llm.invoked).toBe(true);
    expect(decision.llm.budget_state).toBe('error');
    expect(decision.verdict).toBe('hold');
  });

  it('outbound never invokes the LLM', async () => {
    const ai: AiBinding = { run: vi.fn() };
    const decision = await evaluatePolicy(
      baseInput({
        direction: 'outbound',
        stream_type: 'transactional',
        env: {
          DB: makeStubDb(),
          KV: makeStubKv(),
          AI: ai,
        },
        // Force into uncertain band.
        sender: { address: 'app@plrs.im', mailbox_id: 'mb1', domain_id: 'dom1', abuse_tier: 2 },
        message: {
          raw_headers: 'Subject: URGENT verify your account',
          headers: { from: 'app@plrs.im', subject: 'URGENT verify your account' },
          body_preview: '',
          content_types: [],
          attachment_filenames: [],
        },
      }),
    );
    expect(decision.llm.invoked).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
    // Uncertain band on outbound = hold.
    expect(['pass_warn', 'hold']).toContain(decision.verdict);
  });
});
