import type { Heuristic } from '../../types.js';

const MACRO_EXTENSIONS: ReadonlyArray<string> = ['.docm', '.xlsm', '.pptm', '.dotm', '.xltm'];

export const attachmentMacroOffice: Heuristic = (input) => {
  const hit = input.message.attachment_filenames.find((f) =>
    MACRO_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)),
  );
  if (!hit) return null;
  return {
    reason_code: 'attachment_macro_office',
    score: -5,
    evidence: `Office document with macros: ${hit}`,
  };
};
