// A review block’s files (#780, note as_BkHPLMds v3): images an agent names for a review, read from its own
// folders as show_app’s data files are (server/agent-files.mjs), checked by their bytes, copied into the blob
// store and kept on the item with each revision. The page loads one only by the item’s route, by its name and
// SHA-256 (servedReviewFile), never by a path in the content.

import { basename } from 'node:path';
import { LIMITS, REVIEW_IMAGES } from '../shared/limits.mjs';
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
 * @returns {Promise<ReviewFile[]>}
 */
export async function storeReviewFiles(rt, wanted, read) {
  if (!Array.isArray(wanted)) throw new AgentFileError('files is a list: [{ name?, path }].');
  if (wanted.length > LIMITS.appFiles) throw new AgentFileError(`A review carries up to ${LIMITS.appFiles} files.`);
  if (!rt.blobs) throw new AgentFileError('This Postbox can’t store files.');
  /** @type {ReviewFile[]} */
  const stored = [];
  let total = 0;
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) throw new AgentFileError(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
    if (stored.some((x) => x.name === name)) throw new AgentFileError(`Two files are named “${name}”.`);
    const buf = await read(f, REVIEW_IMAGES.reviewImageBytes, `the image “${name}” (up to ${REVIEW_IMAGES.reviewImageBytes / MiB} MiB)`);
    total += buf.length;
    if (total > REVIEW_IMAGES.reviewImagesBytes) throw new AgentFileError(`A review’s images are up to ${REVIEW_IMAGES.reviewImagesBytes / MiB} MiB together.`);
    /** @type {{ type: string, width: number, height: number }} */
    let info;
    try {
      info = imageInfo(buf);
    } catch (e) {
      throw new AgentFileError(`The image “${name}”: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { sha256, size } = await rt.blobs.put(buf);
    stored.push({ name, ref: keptRef(path), sha256, size, ...info });
  }
  return stored;
}

/**
 * How an agent on this computer’s review files are read: each from its folders by agentFile.
 * @param {any} rt @param {string} sessionId @returns {(f: any, max: number, what: string) => Promise<Buffer>}
 */
const fromFolders = (rt, sessionId) => (f, max, what) => rt.agentFile(sessionId, typeof f === 'string' ? f : f?.path, max, what);

/**
 * A review’s files as an agent on this computer names them: each read from its folders by agentFile.
 * @param {any} rt @param {string} sessionId @param {unknown} wanted
 */
export const reviewFiles = (rt, sessionId, wanted) => storeReviewFiles(rt, wanted, fromFolders(rt, sessionId));

/**
 * show_block and update_block as an agent calls them (#780): a review block’s files are read and stored here, and
 * the block goes on without them, so the catalog sees only what it validates. Any other tool, or a block with no
 * files, passes as it came. read is how a file’s bytes are had: the agent’s folders over MCP, or a host’s base64
 * for a remote turn (server/remote/turns-tools.mjs), which only that path passes.
 * @param {any} rt @param {string} sessionId @param {string} name  the tool @param {any} args
 * @param {(f: any, max: number, what: string) => Promise<Buffer>} [read]
 * @returns {Promise<{ args: any, files?: ReviewFile[] }>}
 */
export async function blockFiles(rt, sessionId, name, args, read = fromFolders(rt, sessionId)) {
  const block = args?.block;
  if ((name !== 'show_block' && name !== 'update_block') || !block || typeof block !== 'object' || block.files === undefined) return { args };
  if (block.type !== 'review') throw new AgentFileError('Only a review block carries files: images its Markdown shows. Send this block without files.');
  const { files: wanted, ...rest } = block;
  return { args: { ...args, block: rest }, files: await storeReviewFiles(rt, wanted, read) };
}

/**
 * A review item’s file by its name and SHA-256: one on the item’s current revision, or one an earlier revision had
 * (pastFiles), so the diff can show the old figure. Anything else is null, so the route can answer 404 without
 * saying whether the item exists. A published read: it serves what the person sees.
 * @param {any} rt @param {string} threadId @param {string} itemId @param {string} name @param {string} sha256
 * @returns {ReviewFile | null}
 */
function findReviewFile(rt, threadId, itemId, name, sha256) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'block' || it.block?.type !== 'review') return null;
  return [...(it.files ?? []), ...(it.pastFiles ?? [])].find((x) => x.name === name && x.sha256 === sha256) ?? null;
}

/** The bytes of a review item’s file (findReviewFile), or null. @returns {Promise<Buffer | null>} */
export async function reviewFile(rt, threadId, itemId, name, sha256) {
  const found = findReviewFile(rt, threadId, itemId, name, sha256);
  return found && rt.blobs ? rt.blobs.get(found.sha256) : null;
}

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
    'content-disposition': `inline; filename="${found.name}"`,
    'cache-control': 'private, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'same-origin',
  };
  return { bytes: await rt.blobs.get(found.sha256), headers };
}

/**
 * The files an update leaves on the item: the given list, or the last revision’s when it names none, with every
 * file it replaces kept in pastFiles, once each by name and SHA-256.
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
  return { files, pastFiles };
}
