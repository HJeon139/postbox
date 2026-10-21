// The state shape and the reducer, shared by the server’s store and the browser. Every change is an
// event { seq, type, data }; applying the same events in order gives the same state on both sides.

export function emptyState() {
  return {
    version: 1,
    seq: 0,
    settings: { theme: 'system' },
    projects: {},
    personas: {},
    boilerplates: {},
    threads: {},
    sessions: {},
    items: {},
    glossary: {},
    apps: {},
    files: {},
    schedules: {},
  };
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
      s.boilerplates[d.id] = d;
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
    case 'schedule':
      if (d.removed) delete s.schedules[d.id];
      else s.schedules[d.id] = d;
      break;
    case 'glossary':
      (s.glossary[d.threadId] ??= {})[d.entry.key] = d.entry;
      break;
    case 'item.add':
      (s.items[d.threadId] ??= []).push(d.item);
      break;
    case 'item.patch': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) Object.assign(it, d.patch);
      break;
    }
    case 'item.text': {
      const it = s.items[d.threadId]?.find((i) => i.id === d.id);
      if (it) it.text = (it.text ?? '') + d.text;
      break;
    }
    case 'remove': {
      if (d.kind === 'thread') {
        delete s.threads[d.id];
        delete s.items[d.id];
        delete s.glossary[d.id];
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
