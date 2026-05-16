// W2b — pool-workers integration test for the triage handler. Mocks the
// AI binding with deterministic JSON responses keyed by the input.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { triageUnstructuredComplaint } from '../../src/triage.js';

interface TestEnv {
  DB: D1Database;
  AI?: {
    run: (model: string, args: { prompt: string }) => Promise<{ response?: string }>;
  };
  KV_IDEMPOTENCY?: KVNamespace;
}
const testEnv = env as unknown as TestEnv;

function stubAi(canned: Record<string, unknown>): TestEnv['AI'] {
  return {
    async run() {
      return { response: JSON.stringify(canned) };
    },
  };
}

beforeAll(async () => {
  const migrations = inject('migrations');
  await applyD1Migrations(testEnv.DB, migrations);
});

beforeEach(async () => {
  await testEnv.DB.prepare(`DELETE FROM triage_events`).run();
  await testEnv.DB.prepare(`DELETE FROM suppressions`).run();
});

describe('W2b — triage handler', () => {
  it('logs only when AI binding is absent', async () => {
    const r = await triageUnstructuredComplaint(
      { DB: testEnv.DB as unknown as Parameters<typeof triageUnstructuredComplaint>[0]['DB'] },
      {
        rawHeaders: 'From: x@y.com\nSubject: nothing',
        bodyPreview: 'random text',
        inboundAlias: 'abuse@plrs.im',
        sourceMessageId: null,
      },
    );
    expect(r.category).toBe('noise');
    expect(r.actionable).toBe(false);
    expect(r.budgetExceeded).toBe(false); // distinct from budget exhaustion
    const row = await testEnv.DB.prepare(`SELECT model FROM triage_events`).first<{
      model: string;
    }>();
    expect(row?.model).toBe('ai-binding-absent');
  });

  it('classifies as spam_complaint and fires suppression for actionable + high-confidence', async () => {
    const ai = stubAi({
      category: 'spam_complaint',
      actionable: true,
      severity: 'warn',
      confidence: 0.92,
      target_recipient: 'user@isp.example',
      target_sender_principal: null,
      target_message_id: null,
      summary: 'ISP forwarded an end-user spam complaint.',
    });
    const r = await triageUnstructuredComplaint(
      {
        DB: testEnv.DB as unknown as Parameters<typeof triageUnstructuredComplaint>[0]['DB'],
        AI: ai,
      },
      {
        rawHeaders: 'From: postmaster@isp.example',
        bodyPreview: 'A user complained about your newsletter.',
        inboundAlias: 'abuse@plrs.im',
        sourceMessageId: null,
      },
    );
    expect(r.category).toBe('spam_complaint');
    expect(r.actionable).toBe(true);
    expect(r.appliedSuppressionId).toBeTruthy();

    const supp = await testEnv.DB.prepare(
      `SELECT entity_type, reason, source, severity FROM suppressions LIMIT 1`,
    ).first<{ entity_type: string; reason: string; source: string; severity: string }>();
    expect(supp?.entity_type).toBe('recipient');
    expect(supp?.reason).toBe('spam_complaint');
    expect(supp?.source).toBe('llm_triage');
    expect(supp?.severity).toBe('warn');
  });

  it('does not fire suppression below 0.6 confidence', async () => {
    const ai = stubAi({
      category: 'spam_complaint',
      actionable: true,
      severity: 'warn',
      confidence: 0.4,
      target_recipient: 'user@isp.example',
      summary: 'Low-confidence guess.',
    });
    const r = await triageUnstructuredComplaint(
      {
        DB: testEnv.DB as unknown as Parameters<typeof triageUnstructuredComplaint>[0]['DB'],
        AI: ai,
      },
      {
        rawHeaders: '',
        bodyPreview: '',
        inboundAlias: null,
        sourceMessageId: null,
      },
    );
    expect(r.appliedSuppressionId).toBeNull();
    const cnt = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM suppressions`).first<{
      n: number;
    }>();
    expect(cnt?.n).toBe(0);
  });

  it('phishing_report fires critical-severity suppression', async () => {
    const ai = stubAi({
      category: 'phishing_report',
      actionable: true,
      severity: 'critical',
      confidence: 0.99,
      target_recipient: 'victim@example.com',
      summary: 'Domain being used to impersonate our brand.',
    });
    const r = await triageUnstructuredComplaint(
      {
        DB: testEnv.DB as unknown as Parameters<typeof triageUnstructuredComplaint>[0]['DB'],
        AI: ai,
      },
      {
        rawHeaders: '',
        bodyPreview: '',
        inboundAlias: 'abuse@plrs.im',
        sourceMessageId: null,
      },
    );
    expect(r.category).toBe('phishing_report');
    const supp = await testEnv.DB.prepare(
      `SELECT severity, reason FROM suppressions LIMIT 1`,
    ).first<{ severity: string; reason: string }>();
    expect(supp?.severity).toBe('critical');
    expect(supp?.reason).toBe('phishing_report');
  });

  it('non-actionable categories never fire suppression', async () => {
    const ai = stubAi({
      category: 'inquiry',
      actionable: false,
      severity: 'info',
      confidence: 0.8,
      summary: 'Just a question.',
    });
    const r = await triageUnstructuredComplaint(
      {
        DB: testEnv.DB as unknown as Parameters<typeof triageUnstructuredComplaint>[0]['DB'],
        AI: ai,
      },
      {
        rawHeaders: '',
        bodyPreview: '',
        inboundAlias: null,
        sourceMessageId: null,
      },
    );
    expect(r.actionable).toBe(false);
    expect(r.appliedSuppressionId).toBeNull();
  });
});
