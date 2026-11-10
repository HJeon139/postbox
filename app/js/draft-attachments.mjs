// The files attached to a composer’s unsent draft, kept per thread as its text is (#849). A composer mounts again each
// time its conversation or topic thread is shown, so a list of its own started empty and lost them without a word.
// Every change to a draft’s files goes through here: adding one, an upload finishing or failing, removing one, and
// sending them. The list lives in memory for the page, so an upload still going when its composer is gone finishes
// into the draft it was added to; what’s uploaded is kept in localStorage too, beside the text, so a reload keeps it.
// Only what the composer already holds is kept: a file’s id, name, size and type, or a project file’s path.

/**
 * @typedef {{ kind: 'file', name: string, size?: number, type?: string, fileId?: string, uploading?: boolean }
 *   | { kind: 'project-file', path: string }} DraftAttachment
 */

/** The most files one kept draft holds in localStorage, so a draft can’t fill it. */
const KEEP = 20;
const storageKey = (threadId) => `pb-draft-files-${threadId}`;
/** @type {Map<string, DraftAttachment[]>} */
const drafts = new Map();
/** @type {Map<string, Set<() => void>>} the mounted composers that paint each thread’s draft */
const watchers = new Map();

/** Whether a kept entry is one the composer could have made. @param {any} a */
const usable = (a) =>
  (a?.kind === 'file' && typeof a.fileId === 'string' && typeof a.name === 'string') || (a?.kind === 'project-file' && typeof a.path === 'string');

/** @param {string} threadId @returns {DraftAttachment[]} */
function load(threadId) {
  try {
    const list = JSON.parse(localStorage.getItem(storageKey(threadId)) ?? '[]');
    return Array.isArray(list) ? list.filter(usable).slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

/** Keeps the uploaded files of a draft, or forgets the draft’s entry once it has none. @param {string} threadId */
function store(threadId, /** @type {DraftAttachment[]} */ list) {
  const kept = list.filter(usable).slice(0, KEEP);
  try {
    if (kept.length) localStorage.setItem(storageKey(threadId), JSON.stringify(kept));
    else localStorage.removeItem(storageKey(threadId));
  } catch {}
}

/** @param {string} threadId */
function changed(threadId) {
  store(threadId, drafts.get(threadId) ?? []);
  for (const paint of watchers.get(threadId) ?? []) paint();
}

/**
 * One thread’s draft files. Each call for a thread shares one list, so a composer mounted again sees the files an
 * earlier one added, and an upload that finishes after a switch lands in the draft it was added to.
 * @param {string} threadId
 */
export function draftAttachments(threadId) {
  let list = drafts.get(threadId);
  if (!list) {
    list = load(threadId);
    drafts.set(threadId, list);
  }
  const own = list;
  return {
    /** The draft’s files, in the order they were added. */
    list: () => own,
    /** @param {DraftAttachment} a */
    add(a) {
      own.push(a);
      changed(threadId);
    },
    /** An upload finished: what the server kept. Nothing, when the file was removed while it uploaded. */
    update(/** @type {DraftAttachment} */ a, /** @type {Partial<DraftAttachment>} */ fields) {
      if (!own.includes(a)) return;
      Object.assign(a, fields);
      changed(threadId);
    },
    /** @param {DraftAttachment} a */
    remove(a) {
      const i = own.indexOf(a);
      if (i >= 0) own.splice(i, 1);
      changed(threadId);
    },
    /** The message was sent with them. */
    clear() {
      own.splice(0);
      changed(threadId);
    },
    /** Calls paint on every change to this thread’s draft, until the returned function stops it. @param {() => void} paint */
    watch(paint) {
      const set = watchers.get(threadId) ?? new Set();
      watchers.set(threadId, set);
      set.add(paint);
      return () => set.delete(paint);
    },
  };
}
