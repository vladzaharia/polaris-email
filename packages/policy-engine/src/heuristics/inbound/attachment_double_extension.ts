import type { Heuristic } from '../../types.js';

const SUSPICIOUS_DOUBLE =
  /\.(pdf|doc|docx|xls|xlsx|jpg|png|html?)\.(exe|scr|vbs|js|bat|cmd|com|pif)$/i;

export const attachmentDoubleExtension: Heuristic = (input) => {
  const hit = input.message.attachment_filenames.find((f) => SUSPICIOUS_DOUBLE.test(f));
  if (!hit) return null;
  return {
    reason_code: 'attachment_double_extension',
    score: -7,
    evidence: `Attachment with double-extension trick: ${hit}`,
  };
};
