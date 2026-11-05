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
  for (const { name, path, buf, info } of checked) {
    const { sha256, size, fresh } = await rt.blobs.put(buf, { staged: true });
    puts.push({ sha256, fresh });
    stored.push({ name, ref: keptRef(path), sha256, size, ...info });
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
  const block = args?.block;
  if ((name !== 'show_block' && name !== 'update_block') || !block || typeof block !== 'object' || block.files === undefined) return { args };
  if (block.type !== 'review') throw new AgentFileError('Only a review block carries files: images its Markdown shows. Send this block without files.');
  const { files: wanted, ...rest } = block;
  const { files, settle } = await storeReviewFiles(rt, wanted, read);
  return { args: { ...args, block: rest }, files, settle };
}

/**
 * Runs the tool a call’s review images go with, and settles them (#780): kept when it showed or updated the block,
 * removed from the blob store when it refused or threw, so a refused call leaves no blob behind. ok: false always
 * means the files weren’t kept: an invalid show_block’s item carries none (server/block-show.mjs).
 * @param {{ args: any, settle?: (keep: boolean) => Promise<void> }} app  what blockFiles gave, or an app’s files (no settle) @param {() => any} call
 */
export async function keptIfShown(app, call) {
  let r;
  try {
    r = await call();
  } catch (e) {
    await app.settle?.(false);
    throw e;
  }
  await app.settle?.(r?.ok !== false);
  return r;
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
