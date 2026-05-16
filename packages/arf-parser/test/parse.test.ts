import { describe, expect, it } from 'vitest';
import { parseComplaint } from '../src/index.js';

const ARF_FIXTURE = [
  'From: postmaster@isp.example',
  'To: abuse@plrs.im',
  'Subject: spam complaint',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="b1"',
  'MIME-Version: 1.0',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'A user complained.',
  '--b1',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: SomeISP-Feedback/1.0',
  'Version: 1',
  'Original-Mail-From: <noreply@example.com>',
  'Original-Rcpt-To: <user@isp.example>',
  'Arrival-Date: Wed, 1 Jan 2026 12:00:00 +0000',
  'Reporting-MTA: dns; mta.isp.example',
  '',
  '--b1',
  'Content-Type: message/rfc822',
  '',
  'From: noreply@example.com',
  'To: user@isp.example',
  'Message-ID: <abc-123@example.com>',
  'Subject: original',
  '',
  '--b1--',
  '',
].join('\r\n');

const DSN_FIXTURE = [
  'From: MAILER-DAEMON@receiving.example',
  'To: postmaster@plrs.im',
  'Subject: Undelivered Mail Returned to Sender',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="d1"',
  '',
  '--d1',
  'Content-Type: text/plain',
  '',
  'Delivery failed.',
  '--d1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mta.receiving.example',
  'Original-Envelope-Id: queue-12345',
  '',
  'Final-Recipient: rfc822; bounced@example.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
  '',
  '--d1--',
  '',
].join('\r\n');

const UNSTRUCTURED_FIXTURE = [
  'From: angry-user@example.com',
  'To: abuse@plrs.im',
  'Subject: STOP SENDING ME EMAIL',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'I never signed up for this. Please remove me from all your mailing lists.',
  '',
].join('\r\n');

describe('parseComplaint — ARF', () => {
  it('extracts feedback type, original mail-from, rcpt-to, message-id', () => {
    const r = parseComplaint(ARF_FIXTURE);
    expect(r.kind).toBe('arf');
    if (r.kind !== 'arf') return;
    expect(r.feedbackType).toBe('abuse');
    expect(r.originalMailFrom).toBe('<noreply@example.com>');
    expect(r.originalRcptTo).toBe('<user@isp.example>');
    expect(r.originalMessageId).toBe('<abc-123@example.com>');
    expect(r.reportingMta).toBe('dns; mta.isp.example');
  });
});

describe('parseComplaint — DSN', () => {
  it('extracts permanent 5.x.x bounce + recipient', () => {
    const r = parseComplaint(DSN_FIXTURE);
    expect(r.kind).toBe('dsn');
    if (r.kind !== 'dsn') return;
    expect(r.finalRecipient).toBe('bounced@example.com');
    expect(r.status).toBe('5.1.1');
    expect(r.action).toBe('failed');
    expect(r.permanent).toBe(true);
    expect(r.diagnosticCode).toContain('User unknown');
  });
});

describe('parseComplaint — unstructured', () => {
  it('returns unstructured for plain-text complaints (W2b LLM triage candidate)', () => {
    const r = parseComplaint(UNSTRUCTURED_FIXTURE);
    expect(r.kind).toBe('unstructured');
    if (r.kind !== 'unstructured') return;
    expect(r.contentType).toMatch(/text\/plain/);
    expect(r.bodyPreview).toMatch(/never signed up/);
  });

  it('returns unstructured on completely empty body', () => {
    const r = parseComplaint('From: x@y.com\r\n\r\n');
    expect(r.kind).toBe('unstructured');
  });
});
