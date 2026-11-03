// A conversation’s assets in the store’s reducer (#516 S3; their entries in EVENTS, shared/state.mjs). An asset is
// { id, room, name, created, head, versions }, and each version { v, sha256, size, type, isText, author, at, base,
// op?, pruned? }, where a sha256 of null is a delete; version v is always versions[v - 1]. `assetReleases` maps each
// hash a committed prune or erase released to when, until the load deletes its file (server/asset-orphans.mjs).
//
// `assetRooms` is each room’s index, kept here so a write’s checks look things up instead of scanning every asset
// (server/assets.mjs): { count, ids, names, files, bytes, ops }. `names` maps a live asset’s name key to its id;
// `files` maps each hash the room’s unpruned versions keep to { n, size }, n being how many keep it; `bytes` is the sum
// of those sizes; `ops` maps an op key to its version. All are records with only their own keys (#352), and each
// handler reads what it needs before it changes anything, so an event with missing data throws with the state as it
// was (#609).

const map = () => Object.create(null);

/** The key a name is unique by in its room: NFC, ignoring case, as the person chose (2 November 2026). @param {string} name */
export const nameKey = (name) => name.normalize('NFC').toLowerCase();

/** The key a write’s op is recognized by: its asset, its author and the op (I5). */
export const opKey = (/** @type {string} */ id, /** @type {string} */ author, /** @type {string} */ op) => `${id}\u0000${author}\u0000${op}`;

/** A record’s own value for a key, never one its prototype gives. @param {any} record @param {string} key */
export const own = (record, key) => (record && Object.hasOwn(record, key) ? record[key] : undefined);

/** @param {any} s */
const assetsOf = (s) => (s.assets ??= map());
/** @param {any} s */
const releasesOf = (s) => (s.assetReleases ??= map());

/** A room’s index, made empty the first time the room has an asset. @param {any} s @param {string} room */
function indexOf(s, room) {
  const rooms = (s.assetRooms ??= map());
  if (!own(rooms, room)) rooms[room] = { count: 0, ids: map(), names: map(), files: map(), bytes: 0, ops: map() };
  return rooms[room];
}

/** Whether an asset’s head keeps bytes: it isn’t new and isn’t deleted. @param {any} asset */
const isLive = (asset) => Boolean(asset.versions[asset.head - 1]?.sha256);

/**
 * One more or one fewer version keeping a file: the room’s bytes count the file once, from its first keeper to its last.
 * @param {any} index @param {string} sha @param {number} size @param {1 | -1} by
 */
function keep(index, sha, size, by) {
  const file = own(index.files, sha) ?? (index.files[sha] = { n: 0, size });
  file.n += by;
  if (by > 0 && file.n === 1) index.bytes += file.size;
  if (file.n > 0) return;
  index.bytes -= file.size;
  delete index.files[sha];
}

/**
 * 'asset': an asset made or renamed, without its versions, which it keeps. A rename of a live asset moves its name.
 * @param {any} s @param {any} d
 */
function putAsset(s, d) {
  const { id, room, name, created } = d;
  if (!id || !room || !name) throw new Error('An asset event names its id, room and name.');
  const was = own(assetsOf(s), id);
  const index = indexOf(s, room);
  if (!was) {
    index.count++;
    index.ids[id] = true;
  } else if (isLive(was)) {
    delete index.names[nameKey(was.name)];
    index.names[nameKey(name)] = id;
  }
  assetsOf(s)[id] = { id, room, name, created, head: was?.head ?? 0, versions: was?.versions ?? [] };
}

/**
 * 'asset.version': one version appended, which is the head now, with the versions it pruned and the hashes they
 * released (server/asset-retention.mjs). The room’s index follows: the file it keeps, a name that comes back or goes
 * with a delete, its op, and the files its prunes stop keeping.
 * @param {any} s @param {any} d
 */
function addVersion(s, d) {
  const asset = own(assetsOf(s), d.id);
  const { version, prunes = [], released = [] } = d;
  if (!asset || version?.v !== asset.versions.length + 1) throw new Error(`An asset version is the next one of an asset this state has, not “${d.id}”.`);
  const index = indexOf(s, asset.room);
  const wasLive = isLive(asset);
  asset.versions.push(version);
  asset.head = version.v;
  indexVersion(index, asset, version, wasLive);
  for (const old of prunes.map((v) => asset.versions[v - 1]).filter((x) => x && !x.pruned)) {
    old.pruned = version.at;
    keep(index, old.sha256, old.size, -1);
  }
  for (const sha of released) releasesOf(s)[sha] = version.at;
}

/**
 * A new head in its room’s index: the file it keeps, its name coming back after a delete or going with one, and its op.
 * @param {any} index @param {any} asset @param {any} version @param {boolean} wasLive  whether the head before kept bytes
 */
function indexVersion(index, asset, version, wasLive) {
  if (version.op) index.ops[opKey(asset.id, version.author, version.op)] = version.v;
  if (!version.sha256) {
    if (wasLive) delete index.names[nameKey(asset.name)];
    return;
  }
  keep(index, version.sha256, version.size, 1);
  if (!wasLive) index.names[nameKey(asset.name)] = asset.id;
}

/**
 * 'asset.erase': a conversation erased (server/thread-erase.mjs), its assets with it. Each file its versions keep is
 * released, so the next load deletes it unless another room’s version keeps it too.
 * @param {any} s @param {any} d
 */
function eraseRoom(s, d) {
  if (!d.room) throw new Error('An asset erase names the room.');
  const index = own(s.assetRooms, d.room);
  if (!index) return;
  for (const sha of Object.keys(index.files)) releasesOf(s)[sha] = d.at;
  for (const id of Object.keys(index.ids)) delete assetsOf(s)[id];
  delete s.assetRooms[d.room];
}

/**
 * 'asset.released': hashes whose files the load deleted, or that a version keeps again, no longer released.
 * @param {any} s @param {any} d
 */
function unrelease(s, d) {
  if (!Array.isArray(d.hashes)) throw new Error('An asset release names its hashes.');
  for (const sha of d.hashes) delete releasesOf(s)[sha];
}

/**
 * A state read from JSON (a snapshot, /api/state) with each room index’s records as records with only their own keys,
 * as shared/state.mjs’s ownState makes the collections. @param {any} s
 */
export function ownAssetRooms(s) {
  for (const index of Object.values(s.assetRooms ?? {})) for (const k of ['ids', 'names', 'files', 'ops']) index[k] = Object.assign(map(), index[k]);
}

/** The asset events, as EVENTS entries. Public: they carry metadata only, never an asset’s contents. */
export const ASSET_EVENTS = Object.freeze({
  asset: Object.freeze({ apply: putAsset, public: true }),
  'asset.version': Object.freeze({ apply: addVersion, public: true }),
  'asset.erase': Object.freeze({ apply: eraseRoom, public: true }),
  'asset.released': Object.freeze({ apply: unrelease, public: true }),
});
