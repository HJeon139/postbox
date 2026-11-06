// A conversation’s assets (#516 S3, designs/architecture.md, “Assets”): files agents publish to their room, each a list
// of versions whose bytes are kept once, by SHA-256, in a blob folder of their own (assets/ under the data folder).
// Every write goes through one function commit (server/store-commit.mjs): on the applied state it checks the base, the
// name, the bounds and the budget, and writes the version with what it prunes as one fsynced line, so a version exists
// only once the disk has it, and of two writes from one base exactly one wins. The bytes are put first, so a version
// never names a file that isn’t there; a write refused after that leaves a file nothing names, which the load keeps
// and counts (server/asset-orphans.mjs).

import { join } from 'node:path';
import { ASSETS } from '../shared/limits.mjs';
import { emptyIndex, nameKey, opKey, own } from '../shared/state-assets.mjs';
import { bytesAfter, isTextBytes, prunable } from './asset-retention.mjs';
import { Blobs } from './blobs.mjs';
import { newId } from './store.mjs';

/** The blob folder assets keep their bytes in, apart from the attachments’ blobs/. @param {string} dataDir */
export const assetBlobs = (dataDir) => new Blobs(join(dataDir, 'assets'));

/** A write refused by a rule: nothing was committed, and the agent keeps its own copy. */
export class AssetRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Refuses a write inside the commit: planWrite throws, so the store rejects that commit alone and writes nothing.
 * @param {string} code @param {string} message @returns {never}
 */
function refuse(code, message) {
  throw new AssetRefusal(code, message);
}

/**
 * What’s wrong with a name, or null: a relative path in the room, NFC, at most ASSETS.nameBytes bytes, `/` the only
 * separator, no empty, `.` or `..` part, and no backslash, NUL or control character.
 * @param {unknown} name
 */
export function nameProblem(name) {
  if (typeof name !== 'string' || !name) return 'An asset needs a name, such as notes/plan.md.';
  const n = name.normalize('NFC');
  if (Buffer.byteLength(n) > ASSETS.nameBytes) return `An asset’s name is at most ${ASSETS.nameBytes} bytes.`;
  for (const ch of n) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || ch === '\\') return 'An asset’s name has no backslash or control characters.';
  }
  if (n.startsWith('/')) return 'An asset’s name is relative to the room: it doesn’t start with /.';
  if (n.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'An asset’s name has no empty, . or .. part.';
  return null;
}

/** What’s wrong with a write’s op, or null: none, or 1 to ASSETS.opChars letters, digits, - and _. @param {unknown} op */
export function opProblem(op) {
  if (op === undefined || op === null) return null;
  const ok = typeof op === 'string' && op.length <= ASSETS.opChars && /^[A-Za-z0-9_-]+$/.test(op);
  return ok ? null : `A write’s op is 1 to ${ASSETS.opChars} letters, digits, - and _.`;
}

/**
 * An asset’s version v, or undefined: version v is always versions[v - 1] (shared/state-assets.mjs), so this is the one
 * place that rule is read, for the write path and the tools alike. @param {any} asset @param {unknown} v
 */
export const versionAt = (asset, v) => (Number.isInteger(v) ? asset.versions[/** @type {number} */ (v) - 1] : undefined);

/** The version an asset shows now. @param {any} asset */
export const headOf = (asset) => versionAt(asset, asset.head) ?? null;

/** A room with no assets yet, as its index would read, shared by every read of such a room and never changed. */
const NO_ASSETS = Object.freeze(emptyIndex());

/**
 * A room’s assets, deleted ones included, read through its index: the cost is the room’s, however many other rooms
 * Postbox holds. In no particular order. @param {any} state @param {string} room @returns {any[]}
 */
export function roomAssets(state, room) {
  const index = own(state.assetRooms, room) ?? NO_ASSETS;
  return Object.keys(index.ids).map((id) => own(state.assets, id));
}

/**
 * What a write’s checks read: every asset, and the room’s index, which the reducer keeps so each check is a lookup.
 * @param {any} state @param {string} room
 */
const lookupsFor = (state, room) => ({ assets: state.assets ?? {}, index: own(state.assetRooms, room) ?? NO_ASSETS });

/** The most parents roomOf follows, as Runtime’s lineage does: a thread’s parent is one level, a fork’s a few more. */
const MAX_DEPTH = 8;

/** The room a thread’s assets belong to: its conversation’s root, so side and topic threads share it. */
export function roomOf(threads, threadId) {
  let id = threadId;
  for (let i = 0; i < MAX_DEPTH && threads[id]?.parentId && threads[threads[id].parentId]; i++) id = threads[id].parentId;
  return id;
}

/** An error’s own words, for a message that quotes it. @param {unknown} e */
const said = (e) => (e instanceof Error ? e.message : String(e));

/** What the agent is told, for each refusal and failure: what happened, and what to do next. One place for the wording. */
const SAY = {
  notFound: (id) => `There’s no asset ${id} in this conversation. list_assets gives each asset’s id.`,
  noId: () => 'Name the asset by its id. list_assets gives each asset’s id.',
  noConversation: () => 'This conversation was deleted, and its assets with it, so nothing can be written to it. Nothing was published.',
  deleting: () =>
    'This conversation is being deleted, so nothing can be written to it. Nothing was published; if the person restores it with Undo, write again.',
  nameTaken: (holder) => `The name “${holder.name}” is taken in this conversation, by asset ${holder.id}.`,
  tooManyAssets: (count) => `A conversation holds at most ${ASSETS.roomAssets} assets, and this one has ${count}.`,
  tooManyVersions: (id) => `An asset keeps at most ${ASSETS.assetVersions} versions, and ${id} has them all.`,
  restoreDelete: (v) => `Version ${v} is a delete, so there’s nothing to restore.`,
  noVersion: (id, v) => `Asset ${id} has no version ${v}.`,
  pruned: (v) => `Version ${v} was pruned under the room’s retention rule, so its bytes are gone.`,
  deleted: (id) => `Asset ${id} is deleted already.`,
  stale: (asset, head, base) =>
    `@${head?.author} wrote version ${asset.head} of ${asset.id} since version ${base ?? 'none'}. Read version ${asset.head}, then write again from it.`,
  budget: (total) =>
    `This conversation’s assets would keep ${total} bytes, over its budget of ${ASSETS.roomBytes}. ` +
    'Delete an asset and prune its history, or ask the person to raise the budget.',
  tooBig: (size) => `An asset version is at most ${ASSETS.assetBytes} bytes; this one is ${size}.`,
  noBytes: () => 'A write needs its bytes.',
  failed: (e) => `Postbox couldn’t store the bytes: ${said(e)}. Nothing was published, and your copy is still yours; try again once there’s space.`,
  unconfirmed: (e) =>
    `Postbox couldn’t confirm the write was saved: ${said(e)}. Don’t report it as published: read the asset again, or write again with the same op.`,
};

/** The room’s live asset with this name, ignoring case, other than `except`: one lookup in its index. */
function holderOf(look, name, except = null) {
  const id = own(look.index.names, nameKey(name));
  return id && id !== except ? look.assets[id] : null;
}

/**
 * The hash of the bytes a write’s version would hold, from its base: the write’s, the restored version’s, the base’s
 * for a rename, which keeps them, and null for a delete. A rename or delete request carries no sha256 (#703).
 */
function bytesFrom(asset, req) {
  if (req.kind === 'restore') return versionAt(asset, req.version)?.sha256;
  if (req.kind === 'rename') return versionAt(asset, req.base)?.sha256;
  return req.kind === 'delete' ? null : req.sha256;
}

/**
 * The version that is already this write, or null (I5): one with the write’s op and author, or a head with the same
 * base, bytes and author (and name, for a rename). Durable, unlike the store’s op ids, which a snapshot drops. A
 * retry sends the same name, so a rename compares it exactly, as stored (NFC): one that changes only its case is a
 * new rename, not a repeat.
 */
function repeatOf(look, asset, req) {
  const byOp = req.op && own(look.index.ops, opKey(asset.id, req.author, req.op));
  if (byOp) return versionAt(asset, byOp);
  const head = headOf(asset);
  if (!head || head.author !== req.author || head.base !== (req.base ?? null) || head.sha256 !== bytesFrom(asset, req)) return null;
  return req.kind !== 'rename' || asset.name === req.name.normalize('NFC') ? head : null;
}

/**
 * Refuses a write to a room whose conversation is gone or being deleted (the flag deleting a conversation sets, and
 * Undo clears): checked in the commit, so a write can’t make a room index again after its conversation’s erase.
 */
function checkRoom(state, req) {
  const thread = own(state.threads, req.room);
  if (!thread) refuse('no-conversation', SAY.noConversation());
  if (thread.deleting) refuse('deleting', SAY.deleting());
}

/**
 * The asset a write is to, checked: an existing one in this room, or none for a new one whose name is free. A repeat
 * of a create finds the asset it made.
 */
function targetOf(look, req) {
  if (req.id) {
    const asset = own(look.assets, req.id);
    if (!asset || asset.room !== req.room) refuse('not-found', SAY.notFound(req.id));
    return asset;
  }
  if (req.kind !== 'write') refuse('not-found', SAY.noId());
  const holder = holderOf(look, req.name);
  if (holder && repeatOf(look, holder, { ...req, base: null })) return holder;
  if (holder) refuse('name-taken', `${SAY.nameTaken(holder)} Write to it with its id, or pick another name.`);
  if (look.index.count >= ASSETS.roomAssets) refuse('too-many', SAY.tooManyAssets(look.index.count));
  return null;
}

/** The version a restore or rename takes its bytes from: the one named, or the head; none for a write or delete. */
function sourceOf(asset, req) {
  if (req.kind === 'rename') return headOf(asset);
  if (req.kind !== 'restore') return null;
  const from = versionAt(asset, req.version);
  if (!from) refuse('no-version', SAY.noVersion(asset.id, req.version));
  if (!from.sha256) refuse('no-version', SAY.restoreDelete(req.version));
  if (from.pruned) refuse('pruned', SAY.pruned(req.version));
  return from;
}

/** The new version’s bytes: the write’s, an older version’s for a restore, the head’s for a rename, none for a delete. */
function bytesOf(asset, req) {
  if (req.kind === 'delete') return { sha256: null, size: 0, type: asset.versions.at(-1)?.type ?? null, isText: false };
  const from = sourceOf(asset, req) ?? req;
  return { sha256: from.sha256, size: from.size, type: from.type, isText: from.isText };
}

/**
 * Checks an update against its asset, as the commit sees it: the base is the head (I4), the version bound, a delete
 * of a live asset, and a free name when it changes or a deleted asset comes back.
 */
function checkUpdate(look, asset, req) {
  const head = headOf(asset);
  if ((req.base ?? null) !== asset.head) refuse('stale', SAY.stale(asset, head, req.base));
  if (asset.versions.length >= ASSETS.assetVersions) refuse('too-many', SAY.tooManyVersions(asset.id));
  if (req.kind === 'delete' && !head?.sha256) refuse('deleted', SAY.deleted(asset.id));
  const name = req.kind === 'rename' ? req.name : asset.name;
  const comesBack = !head?.sha256 && req.kind !== 'delete';
  const holder = req.kind === 'rename' || comesBack ? holderOf(look, name, asset.id) : null;
  if (holder) refuse('name-taken', SAY.nameTaken(holder));
}

/** The version a write makes: the next number, its bytes, who, when, and the head it was written from. */
function versionOf(asset, req) {
  /** @type {any} */
  const version = { v: (asset?.versions.length ?? 0) + 1, ...bytesOf(asset, req) };
  Object.assign(version, { author: req.author, at: req.at, base: asset?.head ?? null });
  if (req.op) version.op = req.op;
  return version;
}

/**
 * The commit’s events for a write, on the applied state, or a refusal (AssetRefusal). A repeat gives no events and the
 * version it repeats. Pure, so the tests run it on a state of their own.
 * @param {any} state  the store’s applied state
 * @param {any} req  { kind: 'write'|'rename'|'delete'|'restore', room, id?, newId, name?, base?, version?, sha256?,
 *   size?, type?, isText?, author, op?, at }
 * @returns {{ events: any[], id: string, version: any, repeat: boolean }}
 */
export function planWrite(state, req) {
  checkRoom(state, req);
  const look = lookupsFor(state, req.room);
  const asset = targetOf(look, req);
  const repeat = asset && repeatOf(look, asset, req.id ? req : { ...req, base: null });
  if (repeat) return { events: [], id: asset.id, version: repeat, repeat: true };
  if (asset) checkUpdate(look, asset, req);
  const id = asset?.id ?? req.newId;
  const version = versionOf(asset, req);
  const prunes = prunable([...(asset?.versions ?? []), version]);
  const pruned = prunes.map((v) => versionAt(asset, v));
  const total = bytesAfter(look.index, version, pruned);
  if (total > ASSETS.roomBytes && total > look.index.bytes) refuse('budget', SAY.budget(total));
  const named = !asset || req.kind === 'rename' ? [assetEvent(asset, req, id)] : [];
  const versioned = { type: 'asset.version', data: { id, version, prunes, released: pruned.map((x) => x.sha256) } };
  return { events: [...named, versioned], id, version, repeat: false };
}

/** The 'asset' event a create or rename writes: the asset’s name, NFC, and when it was made. */
function assetEvent(asset, req, id) {
  return { type: 'asset', data: { id, room: req.room, name: req.name.normalize('NFC'), created: asset?.created ?? req.at } };
}

/** What’s wrong with a write before anything is stored (F1), or null: its name, its op, its size, its bytes. */
function writeProblem(req) {
  const named = (req.kind === 'write' && !req.id) || req.kind === 'rename';
  if (named && nameProblem(req.name)) return nameProblem(req.name);
  if (opProblem(req.op)) return opProblem(req.op);
  if (req.bytes && req.bytes.length > ASSETS.assetBytes) return SAY.tooBig(req.bytes.length);
  if (req.kind === 'write' && !req.bytes) return SAY.noBytes();
  return null;
}

/**
 * @typedef {{ ok: true, id: string, version: any, repeat: boolean }} Published
 * @typedef {{ ok: false, code: string, message: string, cause?: unknown }} NotPublished
 */

/**
 * Publishes one version through the store’s one commit path. Checks the name, op and size before anything is written
 * (F1), puts the bytes (F2), then commits; a refusal there leaves the bytes unnamed (F3). A commit the store couldn’t
 * confirm (F5, F7) is reported as not confirmed, never as published.
 * @param {import('./store.mjs').Store} store @param {Blobs} blobs
 * @param {any} req  as planWrite’s, with `bytes` (a Buffer) for a write in place of sha256, size and isText
 * @returns {Promise<Published | NotPublished>}
 */
export async function writeAsset(store, blobs, req) {
  const problem = writeProblem(req);
  if (problem) return { ok: false, code: 'invalid', message: problem };
  const at = req.at ?? Date.now();
  let put = {};
  if (req.bytes) {
    try {
      const { sha256, size } = await blobs.put(req.bytes);
      put = { sha256, size, isText: isTextBytes(req.bytes) };
    } catch (e) {
      return { ok: false, code: 'failed', message: SAY.failed(e), cause: e };
    }
  }
  /** @type {any} */
  let out = null;
  try {
    await store.commit((state) => {
      out = planWrite(state, { ...req, ...put, bytes: undefined, newId: req.newId ?? newId('as'), at });
      return out.events;
    });
  } catch (e) {
    if (e instanceof AssetRefusal) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'unconfirmed', message: SAY.unconfirmed(e), cause: e };
  }
  return { ok: true, id: out.id, version: out.version, repeat: out.repeat };
}
