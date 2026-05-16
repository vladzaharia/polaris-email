import type { Heuristic } from '../../types.js';

const SUSPICIOUS_DOUBLE =
  /\.(pdf|doc|docx|xls|xlsx|jpg|png|html?)\.(exe|scr|vbs|js|bat|cmd|com|pif)$/i;

// Agent-generated payload should never have double-extension.
export const attachmentDoubleExtension: Heuristic = (input) => {
  const hit = input.message.attachment_filenames.find((f) => SUSPICIOUS_DOUBLE.test(f));
  if (!hit) return null;
  return {
    reason_code: 'attachment_double_extension',
    score: -15,
    evidence: `Outbound double-extension attachment: ${hit}`,
  };
};
