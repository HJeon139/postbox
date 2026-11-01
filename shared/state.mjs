// The state shape and the reducer, shared by the server’s store and the browser. Every change is an
// event { seq, type, data }; applying the same events in order gives the same state on both sides.

import { applyHost } from './state-hosts.mjs';

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
  };
}

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

// The reducer. Events carry whole objects for upserts, and small patches for items and sessions (session.patch).
export function apply(s, type, d) {
  switch (type === 'session.patch' ? 'session' : type) {
    case 'settings':
      Object.assign(s.settings, d);
      break;
    case 'project':
      s.projects[d.id] = d;
      break;
    case 'persona':
      s.personas[d.id] = d;
      break;
    case 'boilerplate':
      putBoilerplate(s, d);
      break;
    case 'thread':
      s.threads[d.id] = d;
      break;
    case 'session':
      putSession(s, type, d);
      break;
    case 'app':
      s.apps[d.id] = d;
      break;
    case 'file':
      s.files[d.id] = d;
      break;
    case 'dataset':
      (s.datasets ??= map())[d.id] = d;
      break;
    case 'schedule':
      if (d.removed) delete s.schedules[d.id];
      else s.schedules[d.id] = d;
      break;
    case 'glossary':
      (s.glossary[d.threadId] ??= map())[d.entry.key] = d.entry;
      break;
    case 'item.add':
      (s.items[d.threadId] ??= []).push(d.item);
      break;
    case 'item.patch': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) applyItemPatch(it, d);
      break;
    }
    // An item brought to the newest point (#49, #92): a stub takes its old place, and the item itself, with its id,
    // goes last, so whatever names it (an answer, a needs-you, an app) still finds the one live copy.
    case 'item.move': {
      const list = s.items[d.threadId];
      const i = list?.findIndex((x) => x.id === d.id) ?? -1;
      if (i < 0) break;
      const [it] = list.splice(i, 1, d.stub);
      list.push(Object.assign(it, d.patch));
      break;
    }
    case 'item.text': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) it.text = (it.text ?? '') + d.text;
      break;
    }
    case 'work.add':
      ((s.work ??= map())[d.convId] ??= []).push(d.entry);
      break;
    case 'work.patch': {
      const e = s.work?.[d.convId]?.find((x) => x.id === d.id);
      if (e) Object.assign(e, d.patch);
      break;
    }
    case 'remove':
      removeEntity(s, d);
      break;
    case 'notify':
      break; // transient: shown as a toast, nothing to store
    default:
      if (!applyHost(s, type, d)) throw new Error(`Unknown store event “${type}”.`);
  }
}

/**
 * A whole session, or a session.patch: only a session’s changed fields (designs/508, “Store events”), with the ones it
 * unsets by name, since JSON drops an undefined. A patch makes a new object, as a whole session did, so a reference to
 * the old one still reads as it was; a patch for a session that’s gone changes nothing.
 */
function putSession(s, type, d) {
  if (type === 'session') s.sessions[d.id] = d;
  else if (s.sessions[d.id]) s.sessions[d.id] = patchSession(s.sessions[d.id], d);
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

/** Removing an existing public entity; records have their own lifecycle. */
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
