import type { Heuristic } from '../../types.js';

const EXEC_EXTENSIONS: ReadonlyArray<string> = [
  '.exe',
  '.scr',
  '.vbs',
  '.js',
  '.iso',
  '.lnk',
  '.bat',
  '.cmd',
  '.ps1',
  '.jar',
  '.msi',
  '.dll',
  '.com',
  '.pif',
  '.application',
];

const EXEC_MIME_TYPES: ReadonlyArray<string> = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-msi',
  'application/x-iso9660-image',
];

export const attachmentExecutable: Heuristic = (input) => {
  const filenameHit = input.message.attachment_filenames.find((f) =>
    EXEC_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)),
  );
  const mimeHit = input.message.content_types.find((t) =>
    EXEC_MIME_TYPES.includes(t.toLowerCase()),
  );
  if (!filenameHit && !mimeHit) return null;
  return {
    reason_code: 'attachment_executable',
    score: -10,
    evidence: `Executable attachment: ${filenameHit ?? mimeHit}`,
  };
};
