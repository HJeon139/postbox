// A review block’s files (#780, note as_BkHPLMds v3): images an agent names for a review, read from its own
// folders as show_app’s data files are (server/agent-files.mjs), checked by their bytes, copied into the blob
// store and kept on the item with each revision. The page loads one only by the item’s route, by its name and
// SHA-256 (servedReviewFile), never by a path in the content.

import { basename } from 'node:path';
import { LIMITS, REVIEW_IMAGES } from '../shared/limits.mjs';
import { carriesBlockFiles } from '../shared/remote-protocol.mjs';
import { AgentFileError, FILE_NAME } from './agent-files.mjs';
import { imageInfo } from './image-check.mjs';

/** A review’s file as the item keeps it. @typedef {{ name: string, ref: string|null, sha256: string, size: number, type: string, width: number, height: number }} ReviewFile */

const MiB = 1024 * 1024;

/**
 * The relative path an agent gave, kept as a key Markdown can name only when it’s plain (§1): relative, with no
 * `.` or `..` or empty segment, no backslash, no `%`, and no leading `/` or `~`. Otherwise only the name matches.
 * @param {unknown} path @returns {string | null}
 */
export function keptRef(path) {
  if (typeof path !== 'string' || !path || /[\\%]/.test(path) || /^[/~]/.test(path)) return null;
  const parts = path.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..') ? path : null;
}

/**
 * Checks a list of files a review names and stores each: its count and names, its bytes by content, its size, and
 * the revision’s total. read(path, max, what) gives a file’s bytes: the agent’s folder here, or a host’s base64.
 * @param {any} rt  the Runtime @param {unknown} wanted  [{ name?, path }]
 * @param {(f: any, max: number, what: string) => Promise<Buffer>} read
 * @returns {Promise<{ files: ReviewFile[], settle: (keep: boolean) => Promise<void> }>}
 */
export async function storeReviewFiles(rt, wanted, read) {
  if (!Array.isArray(wanted)) throw new AgentFileError('files is a list: [{ name?, path }].');
  if (wanted.length > LIMITS.appFiles) throw new AgentFileError(`A review carries up to ${LIMITS.appFiles} files.`);
  if (!rt.blobs) throw new AgentFileError('This Postbox can’t store files.');
  // Every file is read and checked before any is stored, so a call refused at its last file leaves no blob behind.
  /** @type {{ name: string, path: unknown, buf: Buffer, info: { type: string, width: number, height: number } }[]} */
  const checked = [];
  let total = 0;
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) throw new AgentFileError(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
    if (checked.some((x) => x.name === name)) throw new AgentFileError(`Two files are named “${name}”.`);
    const buf = await read(f, REVIEW_IMAGES.reviewImageBytes, `the image “${name}” (up to ${REVIEW_IMAGES.reviewImageBytes / MiB} MiB)`);
    total += buf.length;
    if (total > REVIEW_IMAGES.reviewImagesBytes) throw new AgentFileError(`A review’s images are up to ${REVIEW_IMAGES.reviewImagesBytes / MiB} MiB together.`);
    checked.push({ name, path, buf, info: imageOf(name, buf) });
  }
  /** @type {ReviewFile[]} */
  const stored = [];
  // Staged: the call that carries them settles them once it’s known whether the block was shown (keptIfShown).
  /** @type {{ sha256: string, fresh: boolean }[]} */
  const puts = [];
  try {
    for (const { name, path, buf, info } of checked) {
      const { sha256, size, fresh } = await rt.blobs.put(buf, { staged: true });
      puts.push({ sha256, fresh });
      stored.push({ name, ref: keptRef(path), sha256, size, ...info });
    }
  } catch (e) {
    // A put that failed settled its own hold (Blobs.put); the ones before it are released here, so none is left.
    await rt.blobs.settle(puts, false);
    throw e;
  }
  return { files: stored, settle: (keep) => rt.blobs.settle(puts, keep) };
}

/** An image’s type and size by its bytes (imageInfo), refused in the agent’s words with its name. @param {string} name @param {Buffer} buf */
function imageOf(name, buf) {
  try {
    return imageInfo(buf);
  } catch (e) {
    throw new AgentFileError(`The image “${name}”: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * How an agent on this computer’s review files are read: each from its folders by agentFile.
 * @param {any} rt @param {string} sessionId @returns {(f: any, max: number, what: string) => Promise<Buffer>}
 */
const fromFolders = (rt, sessionId) => (f, max, what) => rt.agentFile(sessionId, typeof f === 'string' ? f : f?.path, max, what);

/**
 * show_block and update_block as an agent calls them (#780): a review block’s files are read and stored here, and
 * the block goes on without them, so the catalog sees only what it validates. Any other tool, or a block with no
 * files, passes as it came. read is how a file’s bytes are had: the agent’s folders over MCP, or a host’s base64
 * for a remote turn (server/remote/turns-tools.mjs), which only that path passes.
 * @param {any} rt @param {string} sessionId @param {string} name  the tool @param {any} args
 * @param {(f: any, max: number, what: string) => Promise<Buffer>} [read]
 * @returns {Promise<{ args: any, files?: ReviewFile[], settle?: (keep: boolean) => Promise<void> }>}
 */
export async function blockFiles(rt, sessionId, name, args, read = fromFolders(rt, sessionId)) {
  if (!carriesBlockFiles(name, args)) return { args };
  const block = args.block;
  // A withdraw or an outcome applies no revision, so files it carried would be kept with nothing to show them.
  if (Object.hasOwn(block, 'withdraw') || Object.hasOwn(block, 'outcome'))
    throw new AgentFileError('A review’s files go with a revision, not with a withdraw or an outcome. Send it without files.');
  if (block.type !== 'review') throw new AgentFileError('Only a review block carries files: images its Markdown shows. Send this block without files.');
  const { files: wanted, ...rest } = block;
  const { files, settle } = await storeReviewFiles(rt, wanted, read);
  return { args: { ...args, block: rest }, files, settle };
}

/**
 * Runs the tool a call’s review images go with, and settles them (#780, #828): kept when an item took them, and
 * removed from the blob store otherwise, so a call that refused, threw, or answered without showing them leaves no
 * blob behind. The tool says an item took them by setting given.held where it writes them onto the item
 * (server/block-show.mjs, server/blocks.mjs); its reply’s ok decides nothing.
 * @param {{ args: any, files?: any[], settle?: (keep: boolean) => Promise<void> }} app  what blockFiles gave, or an
 *   app’s files (no settle)
 * @param {(given: { files?: any[], held?: boolean }) => any} call  the tool, given the files
 */
export async function keptIfShown(app, call) {
  /** @type {{ files?: any[], held?: boolean }} */
  const given = app.files ? { files: app.files, held: false } : {};
  try {
    return await call(given);
  } finally {
    await app.settle?.(given.held === true);
  }
}

/**
 * A review item’s file by its name and SHA-256: one on the item’s current revision, or one an earlier revision had
 * (pastFiles), so a page still showing that revision can load it. Anything else is null, so the route can answer 404 without
 * saying whether the item exists. A published read: it serves what the person sees.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} name @param {string} sha256
 * @returns {ReviewFile | null}
 */
function findReviewFile(rt, threadId, itemId, name, sha256) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'block' || it.block?.type !== 'review') return null;
  return [...(it.files ?? []), ...(it.pastFiles ?? [])].find((x) => x.name === name && x.sha256 === sha256) ?? null;
}

/**
 * The header that keeps a stored file to Postbox’s own page (#780, #820): a page on another site can’t embed it, as an
 * image or a no-cors request, to learn whether it loaded, its size or its timing. Every route that serves a stored
 * file’s bytes sends it (a file, an app’s data file, a review’s image, a command’s output), except /media/<name>.
 *
 * /media/<name> sends no Cross-Origin-Resource-Policy, by decision (#992). An app’s sandboxed frame loads its images
 * from there, and its origin is opaque: same-origin and same-site both refuse an opaque origin, so either would block
 * every app image, and cross-origin is what no header already means. Nor can the server tell the frame’s request from
 * another site’s: both come as Sec-Fetch-Site cross-site, mode no-cors, dest image (Firefox adds Origin: null, as any
 * sandboxed page does), measured in Chromium and Firefox. A token in the URL per frame would keep them apart, and was
 * declined: agents name these URLs in the code they write. So a site open in the same browser can embed a name it
 * guesses and learn whether the person’s media folder has that file, and its size (an image’s width and height, or a
 * load’s timing). It can’t read the bytes through any script API, since the route sends no open CORS header; but
 * without CORP the response does reach that site’s renderer process, so a speculative-execution read where site isolation is
 * weak can’t be ruled out. The folder holds what agents copy there to show in apps, and the route serves only files
 * inside it with an image’s extension (server/served-files.mjs).
 * Chromium’s Local Network Access checks also refuse a public site’s request to 127.0.0.1 unless the person allows it.
 */
export const SAME_ORIGIN_ONLY = Object.freeze({ 'cross-origin-resource-policy': 'same-origin' });

/**
 * The route’s answer for a review’s image (§4): its bytes, with /api/files’s headers for an inline image, plus
 * Cross-Origin-Resource-Policy: same-origin so a page on another site can’t embed it. Null for anything else.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} name @param {string} sha256
 * @returns {Promise<{ bytes: Buffer, headers: Record<string, string> } | null>}
 */
export async function servedReviewFile(rt, threadId, itemId, name, sha256) {
  const found = findReviewFile(rt, threadId, itemId, name, sha256);
  if (!found || !rt.blobs) return null;
  const headers = {
    'content-type': found.type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    // FILE_NAME already allows only letters, digits and - _ . in a name; this keeps the header whole regardless.
    'content-disposition': `inline; filename="${found.name.replace(/[^\w.-]/g, '_')}"`,
    'cache-control': 'private, max-age=31536000, immutable',
    ...SAME_ORIGIN_ONLY,
  };
  const bytes = await rt.blobs.get(found.sha256).catch((e) => {
    if (e?.code === 'ENOENT') return null;
    throw e;
  });
  // A blob gone from the store is the same miss as any other (§4): the route’s 404, never a path in a 500.
  return bytes ? { bytes, headers } : null;
}

/**
 * The files an update leaves on the item: the given list, or the last revision’s when it names none, with every
 * file it replaces kept in pastFiles, once each by name and SHA-256, up to the newest reviewPastFiles.
 * @param {any} existing  the item @param {ReviewFile[] | undefined} given
 */
export function revisedFiles(existing, given) {
  const files = given ?? existing.files ?? [];
  const before = [...(existing.pastFiles ?? []), ...(given ? (existing.files ?? []) : [])];
  const seen = new Set();
  const pastFiles = before.filter((x) => {
    const k = `${x.name}\0${x.sha256}`;
    if (seen.has(k) || files.some((y) => y.name === x.name && y.sha256 === x.sha256)) return false;
    seen.add(k);
    return true;
  });
  // The newest replaced files only (REVIEW_IMAGES.reviewPastFiles), so the list stays bounded.
  return { files, pastFiles: pastFiles.slice(-REVIEW_IMAGES.reviewPastFiles) };
}
