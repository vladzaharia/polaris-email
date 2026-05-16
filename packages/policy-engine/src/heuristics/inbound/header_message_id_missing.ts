import type { Heuristic } from '../../types.js';

export const headerMessageIdMissing: Heuristic = (input) => {
  if (input.message.headers['message-id']) return null;
  return {
    reason_code: 'header_message_id_missing',
    score: -2,
    evidence: 'No Message-ID header (rare on legitimate mail; common on bulk spam software)',
  };
};
