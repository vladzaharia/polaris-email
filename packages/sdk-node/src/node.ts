// `@polaris/sdk/node` — Node-only helpers (file uploads from disk, streams).
//
// These are kept out of the default entry point so browser/edge consumers
// don't pay for the `node:fs` import.
import { readFile } from 'node:fs/promises';
import type { SendRequestAttachment } from './generated/index.js';

/**
 * Read a file from disk and turn it into a `SendRequest.attachments[]` entry.
 * The whole file is loaded into memory; for very large attachments prefer the
 * forthcoming streaming variant.
 */
export async function attachmentFromFile(
  filePath: string,
  options: { filename?: string; contentType?: string } = {},
): Promise<SendRequestAttachment> {
  const buf = await readFile(filePath);
  const last = filePath.replace(/\\/g, '/').split('/').pop() ?? 'attachment';
  return {
    filename: options.filename ?? last,
    content_type: options.contentType ?? 'application/octet-stream',
    content_base64: buf.toString('base64'),
  };
}
