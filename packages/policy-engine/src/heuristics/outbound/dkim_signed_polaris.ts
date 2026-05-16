import type { Heuristic } from '../../types.js';

interface DomainRow {
  dkim_selector: string | null;
}

// Sender domain has been configured with a polaris{YYYY} DKIM selector
// (W10's additive selector). Confidence-boost signal.
export const dkimSignedPolaris: Heuristic = async (input) => {
  if (!input.sender.domain_id) return null;
  const row = await input.env.DB.prepare(
    `SELECT dkim_selector FROM mail_domains WHERE id=? LIMIT 1`,
  )
    .bind(input.sender.domain_id)
    .first<DomainRow>();
  if (!row?.dkim_selector) return null;
  if (!row.dkim_selector.startsWith('polaris')) return null;
  return {
    reason_code: 'dkim_signed_polaris',
    score: 2,
    evidence: `Sender domain configured with polaris selector ${row.dkim_selector}`,
  };
};
