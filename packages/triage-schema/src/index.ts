// W2b — Shared taxonomy + Zod schema for LLM-assisted complaint triage.
//
// The Worker passes this schema to env.AI.run() as a JSON-mode response_format,
// so the LLM is constrained to produce strictly-valid JSON matching the
// TriageClassification shape. The dispatch table in services/in then
// consumes the classification + actionable flag to decide on suppression/
// alerting actions.
import { z } from 'zod';

/**
 * Fixed-vocabulary categories the LLM may return. Each maps to a concrete
 * downstream behavior in services/in/src/triage.ts.
 */
export const TriageCategory = z.enum([
  'spam_complaint',
  'phishing_report',
  'bounce_notification',
  'mailing_list_admin',
  'legal_takedown',
  'inquiry',
  'auto_reply',
  'noise',
]);
export type TriageCategory = z.infer<typeof TriageCategory>;

export const TriageSeverity = z.enum(['info', 'warn', 'critical']);
export type TriageSeverity = z.infer<typeof TriageSeverity>;

export const TriageClassification = z.object({
  category: TriageCategory,
  /** True when the platform should ACT on this (suppress, alert, etc.). */
  actionable: z.boolean(),
  severity: TriageSeverity,
  /** Model's self-reported confidence 0.0–1.0. We bucket >=0.7 as high. */
  confidence: z.number().min(0).max(1),
  /** Recipient mentioned in the complaint (the END user), when extractable. */
  target_recipient: z.string().nullable().optional(),
  /** Sender principal (us) the complaint targets, when extractable. */
  target_sender_principal: z.string().nullable().optional(),
  /** Original complained-about Message-ID, when present. */
  target_message_id: z.string().nullable().optional(),
  /** Short human summary the operator panel shows. */
  summary: z.string().min(1).max(2000),
});
export type TriageClassification = z.infer<typeof TriageClassification>;

/** JSON Schema (Draft-07 subset) the Workers AI response_format expects.
 *  Kept hand-rolled to match the Zod shape above without an extra
 *  zod-to-json-schema dependency. */
export const TRIAGE_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: TriageCategory.options },
    actionable: { type: 'boolean' },
    severity: { type: 'string', enum: TriageSeverity.options },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    target_recipient: { type: ['string', 'null'] },
    target_sender_principal: { type: ['string', 'null'] },
    target_message_id: { type: ['string', 'null'] },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
  },
  required: ['category', 'actionable', 'severity', 'confidence', 'summary'],
  additionalProperties: false,
} as const;

/**
 * Build the prompt for the LLM. Designed to be model-agnostic; works well on
 * llama-3.1-8b-instruct / phi-3-mini / mistral-7b on Workers AI.
 *
 * Caps the body preview at 4000 chars so the prompt stays under ~5k tokens
 * (the budget cap declared in W2b's plan).
 */
export function buildTriagePrompt(args: {
  rawHeaders: string;
  bodyPreview: string;
  rcpt?: string;
}): string {
  return [
    'You are a mail-abuse triage assistant for a managed email platform.',
    'Classify the inbound complaint email below into the JSON schema you have been given.',
    '',
    'CATEGORIES (pick exactly one):',
    '  - spam_complaint:      end user reports our mail as spam',
    '  - phishing_report:     reports our domain being used to impersonate / phish',
    '  - bounce_notification: forwarded DSN or MAILER-DAEMON message',
    '  - mailing_list_admin:  unsubscribe-confirmation or list-management auto-reply',
    '  - legal_takedown:      lawyer / law-enforcement notice (DMCA, abuse@ subpoena)',
    '  - inquiry:             a human asking a question or reporting an issue',
    '  - auto_reply:          out-of-office / vacation autoresponder',
    '  - noise:               random / unrelated / spam to our abuse address',
    '',
    'ACTIONABLE (boolean):',
    '  true  - the platform should take an automated action (suppress recipient,',
    '          pause sender, alert ops). Set true only when both the category',
    '          warrants action AND the relevant addresses/IDs are extractable.',
    '  false - log only.',
    '',
    'SEVERITY:',
    '  info     - logging only',
    '  warn     - operator should review',
    '  critical - phishing, legal, or large-scale impact',
    '',
    'EXTRACT verbatim addresses + IDs from the complaint text/headers when',
    'present. NEVER invent addresses; emit null when absent.',
    '',
    'CONFIDENCE: your own 0.0..1.0 self-rating. Below 0.6 means a human',
    'should review before any action is taken.',
    '',
    args.rcpt ? `Delivered to platform alias: ${args.rcpt}` : '',
    '',
    'HEADERS:',
    args.rawHeaders.slice(0, 4000),
    '',
    'BODY:',
    args.bodyPreview.slice(0, 4000),
  ]
    .filter(Boolean)
    .join('\n');
}
