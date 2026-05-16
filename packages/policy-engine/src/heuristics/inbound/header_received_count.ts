import type { Heuristic } from '../../types.js';

const THRESHOLD = 12;

export const headerReceivedCount: Heuristic = (input) => {
  const count = (input.message.raw_headers.match(/^received:/gim) ?? []).length;
  if (count <= THRESHOLD) return null;
  return {
    reason_code: 'header_received_count',
    score: -2,
    evidence: `${count} Received headers (>${THRESHOLD} suggests relay laundering)`,
  };
};
