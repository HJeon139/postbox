// The extension an attached file’s path ends in, for the agent that reads it (#1307). Uploads are stored by hash, with
// no extension (server/blobs.mjs), and some backends decide how to read a file by its extension alone: Kiro read an
// attached PNG at its stored path as plain text, and reads the same bytes as an image at a .png path. So an image’s
// type names its extension, whatever the person’s file was called (a pasted screenshot can be named “image”); any
// other file keeps its name’s.

/** The types each backend reads as an image or a document, by the extension they read them by. */
const BY_TYPE = /** @type {Record<string, string>} */ ({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
});

/**
 * The extension for an upload, with its dot, or '' for none: its type’s, else its name’s, letters and digits only.
 * @param {{ name?: unknown, type?: unknown }} file
 */
export function extensionOf(file) {
  const byType = BY_TYPE[String(file?.type ?? '').toLowerCase()];
  if (byType) return byType;
  return /\.[A-Za-z0-9]{1,12}$/.exec(String(file?.name ?? ''))?.[0] ?? '';
}
