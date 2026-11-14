// The part of tests/arrange.mjs that stands in for what a Postbox is started with or hears: fake backends, processes
// and stores, the seams the server looks for before its own, and listeners on what it writes. tests/arrange.mjs
// re-exports each helper, so tests use them as `arrange.<name>`. Moved out of tests/arrange.mjs.

/** @typedef {import('../server/runtime.mjs').Runtime} Runtime */

// ── Fakes ────────────────────────────────────────────────────────────────────────────

/** Registers a fake backend under its own name, replacing any of that name. @param {Runtime} rt @param {object} adapter @param {object} [opts] */
export const withAdapter = (rt, adapter, opts) => rt.adapters.register(/** @type {any} */ (adapter), opts);

/** Gives the server another place to store files, or none, as a Postbox started with it would have. @param {Runtime} rt @param {any} blobs */
export function withBlobs(rt, blobs) {
  rt.blobs = blobs;
  rt.assets.blobs = blobs;
}

/** Unregisters a backend. @param {Runtime} rt @param {string} name */
export const withoutAdapter = (rt, name) => rt.adapters.adapters.delete(name);

/**
 * Unregisters every backend, as a Postbox started without any, in the registry the server holds: Runtime and
 * Placement share it, so it changes in place, never by a new one. Returns a function that registers them again, each
 * where it ran. @param {Runtime} rt
 */
export function withoutAdapters(rt) {
  const registry = rt.adapters;
  const was = [...registry.adapters.values()].map((a) => ({ adapter: a, here: !registry.hostOnly.has(a.name) }));
  registry.adapters.clear();
  registry.hostOnly.clear();
  return () => {
    for (const { adapter, here } of was) registry.register(adapter, { here });
  };
}

/** Why a backend can’t run on this computer, as a turn or a request for it is refused. @param {Runtime} rt @param {string} backend */
export const notHere = (rt, backend) => rt.placement.notHere(backend);

/** The backend registered under a name. @param {Runtime} rt @param {string} name */
export const adapter = (rt, name) => rt.adapters.get(name);

/** What a registered backend can do. @param {Runtime} rt @param {string} name */
export const capabilitiesOf = (rt, name) => rt.adapters.get(name).capabilities;

/** The names of the backends registered. @param {Runtime} rt */
export const adapterNames = (rt) => rt.adapters.names();

/**
 * Fakes the processes Postbox lists and signals, to stop a turn’s or a kept job’s process tree without one. Returns a
 * function that puts back what it replaced.
 * @param {Runtime} rt @param {{ list?: () => Promise<object[]>, signal?: (pid: number, sig: string) => any }} fakes
 */
export function withProcesses(rt, { list, signal }) {
  const was = { list: rt.listProcesses, signal: rt.signalProcess };
  if (list) rt.listProcesses = /** @type {any} */ (list);
  if (signal) rt.signalProcess = /** @type {any} */ (signal);
  return () => {
    if (list) rt.listProcesses = was.list;
    if (signal) rt.signalProcess = was.signal;
  };
}

/**
 * Sets one of the seams the server looks for before its own (rt.judge, rt.pushes, rt.summarize), or removes it, given
 * undefined, so the server’s own runs again. @param {Runtime} rt @param {string} name @param {any} value
 */
function seam(rt, name, value) {
  const r = /** @type {any} */ (rt);
  if (value === undefined) delete r[name];
  else r[name] = value;
}

/** Replaces the model that judges a write’s intent; undefined restores the real one. @param {Runtime} rt @param {any} judge */
export const withJudge = (rt, judge) => seam(rt, 'judge', judge);

/** Replaces how a push is read and run; undefined restores the real one. @param {Runtime} rt @param {any} pushes */
export const withPushes = (rt, pushes) => seam(rt, 'pushes', pushes);

/** Replaces the model that summarizes a thread; undefined restores the real one. @param {Runtime} rt @param {any} summarize */
export const withSummarizer = (rt, summarize) => seam(rt, 'summarize', summarize);

/**
 * Hears each change to an item, before it’s written as it would be. Returns a function that stops listening.
 * @param {Runtime} rt @param {(threadId: string, itemId: string, patch: object) => void} fn
 */
export function onItemPatch(rt, fn) {
  const { threads } = rt;
  const patchItem = threads.patchItem.bind(threads);
  threads.patchItem = (threadId, itemId, patch) => {
    fn(threadId, itemId, patch);
    return patchItem(threadId, itemId, patch);
  };
  return () => {
    threads.patchItem = patchItem;
  };
}

/**
 * Hears each change to a session, before it’s written as it would be. Returns a function that stops listening.
 * @param {Runtime} rt @param {(sessionId: string, change: any) => void} fn
 */
export function onSessionUpdate(rt, fn) {
  const { sessions } = rt;
  const update = sessions.update.bind(sessions);
  sessions.update = (id, change) => {
    fn(id, change);
    return update(id, change);
  };
  return () => {
    sessions.update = update;
  };
}

/**
 * Hears each Postbox notice left for an agent, before it’s written as it would be. Returns a function that stops listening.
 * @param {Runtime} rt @param {(sessionId: string, text: string) => void} fn
 */
export function onTell(rt, fn) {
  const { sessions } = rt;
  const tell = sessions.tell.bind(sessions);
  sessions.tell = (id, text) => {
    fn(id, text);
    return tell(id, text);
  };
  return () => {
    sessions.tell = tell;
  };
}

/**
 * Hears each notification the server raises, before it goes out as it would. Returns a function that stops listening.
 * @param {Runtime} rt @param {(level: string, ...rest: any[]) => void} fn
 */
export function onNotify(rt, fn) {
  const { threads } = rt;
  const notify = threads.notify.bind(threads);
  threads.notify = (level, ...rest) => {
    fn(level, ...rest);
    return notify(level, ...rest);
  };
  return () => {
    threads.notify = notify;
  };
}
