// What Work’s viewer reads (#1446): a room asset’s bytes, and a changed file as the agents left it. Both are GETs the
// page loads by a same-origin path, answered only for the conversation in the path, with /api/files’s headers: text
// comes as text/plain and the four safe image types inline, anything else as a download, and nothing runs as a page
// (designs/architecture/assets.md, “Assets”).

import { INLINE_TYPES } from '../shared/files.mjs';
import { own } from '../shared/state-assets.mjs';
import { roomOf, versionAt } from './assets.mjs';
import { httpError } from './helpers.mjs';
import { SAME_ORIGIN_ONLY } from './review-files.mjs';
import { decodePath } from './served-files.mjs';
import { workCopy } from './work-view.mjs';

/** The image types a changed file is served as, by its extension: the ledger keeps bytes, not a type. */
const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const MISSING = 'That asset isn’t in this conversation, or that version isn’t kept.';

/** The type a file shows inline as, or null for one that downloads. @param {string} type @param {boolean} isText */
function shownAs(type, isText) {
  if (INLINE_TYPES.has(type)) return type;
  return isText ? 'text/plain; charset=utf-8' : null;
}

/**
 * The headers a viewed file goes with: text as text/plain, a safe image as itself, anything else, or anything asked
 * for as a download, as application/octet-stream.
 * @param {string} name  its file name, for the download @param {{ type: string, isText: boolean, download: boolean }} how
 */
export function viewHeaders(name, { type, isText, download }) {
  const shown = download ? null : shownAs(type, isText);
  return {
    'content-type': shown ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-disposition': `${shown ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]/g, '_')}"`,
    'cache-control': 'no-store',
    ...SAME_ORIGIN_ONLY,
  };
}

/**
 * An asset’s version in a conversation: the newest unless v names another. A miss of any kind (another room’s asset,
 * a deleted asset at any version, a pruned version, a blob gone) is the same 404, so an id from elsewhere tells
 * nothing (#31), and a deleted asset can’t be read back through an older version (#1446).
 * @param {any} rt @param {string} threadId @param {string} assetId @param {string|null} v @param {boolean} download
 */
async function assetFile(rt, threadId, assetId, v, download) {
  const state = rt.store.state;
  if (!own(state.threads, threadId)) throw httpError(404, MISSING);
  const asset = own(state.assets, assetId);
  if (!asset || asset.room !== roomOf(state.threads, threadId) || !versionAt(asset, asset.head)?.sha256) throw httpError(404, MISSING);
  const version = versionAt(asset, v ? Number(v) : asset.head);
  const blobs = rt.assets.roomBlobs();
  if (!version?.sha256 || version.pruned || !blobs) throw httpError(404, MISSING);
  const bytes = await blobs.get(version.sha256).catch((e) => {
    if (e?.code === 'ENOENT') throw httpError(404, MISSING);
    throw e;
  });
  return { bytes, headers: viewHeaders(asset.name.replace(/^.*\//, ''), { type: version.type, isText: version.isText, download }) };
}

/** A changed file as the agents left it, from the copy the ledger kept. @param {any} rt */
async function changedFile(rt, threadId, fileId, download) {
  const f = await workCopy(rt.work, threadId, fileId);
  const ext = f.name.replace(/^.*\./, '').toLowerCase();
  const type = (f.binary && own(IMAGES, ext)) || '';
  return { bytes: f.bytes, headers: viewHeaders(f.name, { type, isText: !f.binary, download }) };
}

/**
 * The viewer’s routes, or null for any other request.
 * @param {any} rt @param {string} path @param {string} method @param {URL} url
 * @returns {Promise<{ bytes: Buffer, headers: Record<string, string> } | null>}
 */
export async function roomFileRoute(rt, path, method, url) {
  if (method !== 'GET') return null;
  const download = url.searchParams.get('download') === '1';
  let m = path.match(/^\/api\/threads\/([^/]+)\/assets\/([^/]+)$/);
  if (m) return assetFile(rt, decodePath(m[1]), decodePath(m[2]), url.searchParams.get('v'), download);
  m = path.match(/^\/api\/threads\/([^/]+)\/work\/files\/([^/]+)\/content$/);
  if (m) return changedFile(rt, decodePath(m[1]), decodePath(m[2]), download);
  return null;
}
