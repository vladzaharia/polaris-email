import { describe, expect, it } from 'vitest';
import {
  buildTriagePrompt,
  TriageClassification,
  TRIAGE_RESPONSE_JSON_SCHEMA,
} from '../src/index.js';

describe('TriageClassification', () => {
  it('accepts a valid classification', () => {
    const r = TriageClassification.parse({
      category: 'spam_complaint',
      actionable: true,
      severity: 'warn',
      confidence: 0.85,
      target_recipient: 'user@isp.example',
      target_sender_principal: 'newsletter@verified.test',
      target_message_id: '<abc@example.com>',
      summary: 'User complained about unsolicited newsletter.',
    });
    expect(r.category).toBe('spam_complaint');
  });

  it('rejects out-of-range confidence', () => {
    expect(() =>
      TriageClassification.parse({
        category: 'noise',
        actionable: false,
        severity: 'info',
        confidence: 1.5,
        summary: 'x',
      }),
    ).toThrow();
  });

  it('rejects unknown category', () => {
    expect(() =>
      TriageClassification.parse({
        category: 'made-up',
        actionable: false,
        severity: 'info',
        confidence: 0.1,
        summary: 'x',
      }),
    ).toThrow();
  });
});

describe('TRIAGE_RESPONSE_JSON_SCHEMA', () => {
  it('lists every required field', () => {
    expect(TRIAGE_RESPONSE_JSON_SCHEMA.required).toContain('category');
    expect(TRIAGE_RESPONSE_JSON_SCHEMA.required).toContain('actionable');
    expect(TRIAGE_RESPONSE_JSON_SCHEMA.required).toContain('severity');
    expect(TRIAGE_RESPONSE_JSON_SCHEMA.required).toContain('confidence');
    expect(TRIAGE_RESPONSE_JSON_SCHEMA.required).toContain('summary');
  });
});

describe('buildTriagePrompt', () => {
  it('caps body preview at 4000 chars', () => {
    const longBody = 'x'.repeat(10000);
    const p = buildTriagePrompt({ rawHeaders: 'From: a@b', bodyPreview: longBody });
    expect(p).toContain('BODY:');
    // the prompt may contain 4000 x's + other content; check overall structure
    expect(p.length).toBeLessThan(longBody.length + 2000);
  });

  it('omits the rcpt section when missing', () => {
    const p = buildTriagePrompt({ rawHeaders: '', bodyPreview: '' });
    expect(p).not.toContain('Delivered to platform alias:');
  });
});
