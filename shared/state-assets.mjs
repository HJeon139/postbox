// A conversation’s assets in the store’s reducer (#516 S3; their entries in EVENTS, shared/state.mjs). An asset is
// { id, room, name, created, head, versions }, and each version { v, sha256, size, type, isText, author, at, base,
// op?, pruned? }, where a sha256 of null is a delete. `assetReleases` maps each hash a committed prune or erase released
// to when, until the load deletes its file (server/asset-orphans.mjs). Both are records by id with only their own
// keys, as map() in shared/state.mjs makes them (#352). Each handler reads what it needs before it changes anything,
// so an event with missing data throws with the state as it was (#609).

/** @param {any} s */
const assetsOf = (s) => (s.assets ??= Object.create(null));
/** @param {any} s */
const releasesOf = (s) => (s.assetReleases ??= Object.create(null));

/**
 * 'asset': an asset made or renamed, without its versions, which it keeps.
 * @param {any} s @param {any} d
 */
function putAsset(s, d) {
  const { id, room, name, created } = d;
  if (!id || !room || !name) throw new Error('An asset event names its id, room and name.');
  const was = assetsOf(s)[id];
  assetsOf(s)[id] = { id, room, name, created, head: was?.head ?? 0, versions: was?.versions ?? [] };
}

/**
 * 'asset.version': one version appended, which is the head now, with the versions it pruned and the hashes they
 * released (server/asset-retention.mjs).
 * @param {any} s @param {any} d
 */
function addVersion(s, d) {
  const asset = assetsOf(s)[d.id];
  const { version, prunes = [], released = [] } = d;
  if (!asset || !version?.v) throw new Error(`An asset version names an asset this state has, not “${d.id}”.`);
  asset.versions.push(version);
  asset.head = version.v;
  for (const v of prunes) {
    const old = asset.versions.find((x) => x.v === v);
    if (old) old.pruned = version.at;
  }
  for (const sha of released) releasesOf(s)[sha] = version.at;
}

/**
 * 'asset.erase': a conversation erased (server/thread-erase.mjs), its assets with it. Each kept hash is released, so
 * the next load deletes its file unless another room’s version names it.
 * @param {any} s @param {any} d
 */
function eraseRoom(s, d) {
  if (!d.room) throw new Error('An asset erase names the room.');
  for (const asset of Object.values(assetsOf(s))) {
    if (asset.room !== d.room) continue;
    for (const v of asset.versions) if (v.sha256 && !v.pruned) releasesOf(s)[v.sha256] = d.at;
    delete assetsOf(s)[asset.id];
  }
}

/**
 * 'asset.released': hashes whose files the load deleted, or that a version names again, no longer released.
 * @param {any} s @param {any} d
 */
function unrelease(s, d) {
  if (!Array.isArray(d.hashes)) throw new Error('An asset release names its hashes.');
  for (const sha of d.hashes) delete releasesOf(s)[sha];
}

/** The asset events, as EVENTS entries. Public: they carry metadata only, never an asset’s contents. */
export const ASSET_EVENTS = Object.freeze({
  asset: Object.freeze({ apply: putAsset, public: true }),
  'asset.version': Object.freeze({ apply: addVersion, public: true }),
  'asset.erase': Object.freeze({ apply: eraseRoom, public: true }),
  'asset.released': Object.freeze({ apply: unrelease, public: true }),
});
