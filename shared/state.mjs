// The state shape and the reducer, shared by the server’s store and the browser. Every change is an
// event { seq, type, data }; applying the same events in order gives the same state on both sides.

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

// The reducer. Events carry whole objects for upserts, and small patches for items.
export function apply(s, type, d) {
  switch (type) {
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
      s.sessions[d.id] = d;
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
      if (it) Object.assign(it, d.patch);
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
    case 'remove': {
      if (d.kind === 'thread') {
        delete s.threads[d.id];
        delete s.items[d.id];
        delete s.glossary[d.id];
        if (s.work) delete s.work[d.id];
      }
      if (d.kind === 'session') delete s.sessions[d.id];
      if (d.kind === 'app') delete s.apps[d.id];
      break;
    }
    case 'notify':
      break; // transient: shown as a toast, nothing to store
    default:
      throw new Error(`Unknown store event “${type}”.`);
  }
}
