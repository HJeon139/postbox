// The state shape and the reducer, shared by the server’s store and the browser. Every change is an
// event { seq, type, data }; applying the same events in order gives the same state on both sides.

import { ASSET_EVENTS } from './state-assets.mjs';
import { putHost, putHostStatus } from './state-hosts.mjs';

/**
 * Records by id with nothing but their own keys (#352). An id comes from a request, a tool call or an agent, and in a
 * plain object constructor, toString or __proto__ would find Object, a method or Object.prototype instead of nothing.
 * @param {Record<string, any>} [entries]
 * @returns {Record<string, any>}
 */
export const map = (entries = {}) => Object.assign(Object.create(null), entries);

export function emptyState() {
  return {
    version: 1,
    seq: 0,
    settings: { theme: 'system' },
    projects: map(),
    personas: map(),
    boilerplates: map(),
    threads: map(),
    sessions: map(),
    items: map(),
    glossary: map(),
    apps: map(),
    files: map(),
    // Datasets agents loaded into the corpus (#47), so they’re loaded again after a restart.
    datasets: map(),
    schedules: map(),
    // Remote hosts agents can run on (#120), each with its settings (shared/remote-settings.mjs).
    hosts: map(),
    // Each host’s connection as the host manager last reported it (#120): { state, failure, welcome, lastHeard }.
    // Live state, like a session’s: the server replaces it at each start, since the link it described is gone.
    hostStatus: map(),
    // The work ledger (#132): per conversation, what its agents’ turns changed, ran and published (shared/work.mjs).
    work: map(),
    // A conversation’s assets (#516 S3, shared/state-assets.mjs): each with its versions, metadata only; the bytes are in
    // assets/ under the data folder. And the hashes committed prunes and erases released, until a load deletes them.
    assets: map(),
    assetReleases: map(),
  };
}

/** A glossary entry. Its key is read first, so missing data throws before anything changes (#609). */
const putGlossary = (s, d) => {
  const { key } = d.entry;
  (s.glossary[d.threadId] ??= map())[key] = d.entry;
};

const putBoilerplate = (s, d) => {
  delete s.boilerplates[d.id];
  s.boilerplates[d.id] = d;
};

/** The collections of records by id: every map() in an empty state. */
const MAPS = Object.entries(emptyState()).flatMap(([k, v]) => (v && typeof v === 'object' && Object.getPrototypeOf(v) === null ? [k] : []));

/** A state read from JSON (a snapshot, /api/state), with its collections and each conversation’s glossary as map()s. */
export function ownState(s) {
  for (const c of MAPS) s[c] = map(s[c] ?? {});
  for (const t of Object.keys(s.glossary)) s.glossary[t] = map(s.glossary[t]);
  return s;
}

/**
 * Which keys of the state reach the page (designs/architecture.md, “What reaches the browser”). Every key of
 * emptyState() is in exactly one list (tests/public-state.test.mjs): a new collection reaches the page only by being
 * listed as public, and can’t vanish from it unseen.
 */
export const PUBLIC_STATE_KEYS = Object.freeze([
  'version',
  'seq',
  'settings',
  'projects',
  'personas',
  'boilerplates',
  'threads',
  'sessions',
  'items',
  'glossary',
  'apps',
  'files',
  'datasets',
  'schedules',
  'hosts',
  'hostStatus',
  'work',
  // Metadata only, like files: names, sizes, hashes and authors, never an asset’s contents (#516 S3).
  'assets',
  'assetReleases',
]);
export const PRIVATE_STATE_KEYS = Object.freeze(/** @type {string[]} */ ([]));

/** The names the event stream gives its own frames (server/live-streams.mjs). None is ever an event type. */
export const STREAM = Object.freeze({ cursor: 'cursor', status: 'status', epoch: 'epoch', resync: 'resync' });
export const RESERVED = Object.freeze(Object.values(STREAM));

/** Calls f with the item an event names, if it's there. */
const withItem = (s, d, f) => {
  const it = s.items[d.threadId]?.find((i) => i.id === d.id);
  if (it) f(it);
};

const put = (/** @type {string} */ key) => (/** @type {any} */ s, /** @type {any} */ d) => {
  s[key][d.id] = d;
};

/**
 * Every event type: how the reducer applies it, and whether the page may see it. The reducer, the server’s projection
 * (server/public-state.mjs) and the page’s stream listeners (app/js/client.mjs) all read this one table, so a type the
 * reducer applies has said whether it reaches the browser. Events carry whole objects for upserts, and small patches
 * for items and sessions (session.patch).
 * @type {Readonly<Record<string, { apply: (s: any, d: any) => void, public: boolean }>>}
 */
export const EVENTS = Object.freeze({
  settings: { apply: (s, d) => Object.assign(s.settings, d), public: true },
  project: { apply: put('projects'), public: true },
  persona: { apply: put('personas'), public: true },
  boilerplate: { apply: putBoilerplate, public: true },
  thread: { apply: put('threads'), public: true },
  session: { apply: put('sessions'), public: true },
  // Only a session’s changed fields, with the ones it unsets by name, since JSON drops an undefined (designs/508, “Store
  // events”). A patch makes a new object, as a whole session did, so a reference to the old one still reads as it was;
  // a patch for a session that’s gone changes nothing.
  'session.patch': {
    apply: (s, d) => {
      if (s.sessions[d.id]) s.sessions[d.id] = patchSession(s.sessions[d.id], d);
    },
    public: true,
  },
  app: { apply: put('apps'), public: true },
  file: { apply: put('files'), public: true },
  dataset: { apply: (s, d) => ((s.datasets ??= map())[d.id] = d), public: true },
  schedule: {
    apply: (s, d) => {
      if (d.removed) delete s.schedules[d.id];
      else s.schedules[d.id] = d;
    },
    public: true,
  },
  glossary: { apply: putGlossary, public: true },
  'item.add': { apply: (s, d) => (s.items[d.threadId] ??= []).push(d.item), public: true },
  'item.patch': { apply: (s, d) => withItem(s, d, (it) => applyItemPatch(it, d)), public: true },
  'item.move': { apply: moveItem, public: true },
  'item.text': { apply: (s, d) => withItem(s, d, (it) => (it.text = (it.text ?? '') + d.text)), public: true },
  'work.add': { apply: (s, d) => ((s.work ??= map())[d.convId] ??= []).push(d.entry), public: true },
  'work.patch': { apply: patchWork, public: true },
  remove: { apply: removeEntity, public: true },
  // Transient: shown as a toast, nothing to store.
  notify: { apply: () => {}, public: true },
  host: { apply: putHost, public: true },
  'host.status': { apply: putHostStatus, public: true },
  ...ASSET_EVENTS,
});

// Each entry too, so no code can make a type private or public at run time.
for (const entry of Object.values(EVENTS)) Object.freeze(entry);

/** The event types the page hears: every public entry of EVENTS. */
export const PUBLIC_EVENT_TYPES = Object.freeze(Object.keys(EVENTS).filter((t) => EVENTS[t].public));

/** The reducer: applies one event through its entry in EVENTS. A type with no entry is a programming error. */
export function apply(s, type, d) {
  const entry = Object.hasOwn(EVENTS, type) ? EVENTS[type] : undefined;
  if (!entry) throw new Error(`Unknown store event “${type}”.`);
  entry.apply(s, d);
}

// An item brought to the newest point (#49, #92): a stub takes its old place, and the item itself, with its id, goes
// last, so whatever names it (an answer, a needs-you, an app) still finds the one live copy.
function moveItem(s, d) {
  const list = s.items[d.threadId];
  const i = list?.findIndex((x) => x.id === d.id) ?? -1;
  if (i < 0) return;
  const [it] = list.splice(i, 1, d.stub);
  list.push(Object.assign(it, d.patch));
}

function patchWork(s, d) {
  const e = s.work?.[d.convId]?.find((x) => x.id === d.id);
  if (e) Object.assign(e, d.patch);
}

function removeEntity(s, d) {
  if (d.kind === 'thread') {
    delete s.threads[d.id];
    delete s.items[d.id];
    delete s.glossary[d.id];
    if (s.work) delete s.work[d.id];
  }
  const kept = { session: 'sessions', app: 'apps', persona: 'personas' }[d.kind];
  if (kept) delete s[kept][d.id];
}

/**
 * The session a session.patch leaves, as a new object: the session with the patch’s fields set, and the fields it
 * unsets deleted. The one place that defines what a patch means, so every reader of the log (the reducer, the checks’
 * history in server/room-events.mjs, the UAT runner’s tools/uat/run-files.mjs) reads a patch the same way.
 * @param {Record<string, any>} se  the session as it is
 * @param {{ patch?: Record<string, any>, unset?: string[] }} d  the event’s data
 */
export function patchSession(se, d) {
  const next = { ...se, ...d.patch };
  for (const k of d.unset ?? []) delete next[k];
  return next;
}

/** Apply an ordinary item patch, or one activity step without repeating its accumulated list (#452). */
function applyItemPatch(item, data) {
  if (data.activityStep) {
    const steps = (item.activity ??= { steps: [] }).steps;
    const index = steps.findIndex((step) => step.id === data.activityStep.id);
    if (index < 0) steps.push(data.activityStep);
    else steps[index] = { ...steps[index], ...data.activityStep };
  }
  if (data.patch) Object.assign(item, data.patch);
}
