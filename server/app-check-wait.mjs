// show_app and update_app wait for the version’s pre-display check while a Postbox page is open to run it, up to
// CHECK_WAIT_MS, and their reply carries its result (#337). Agents told the person a version was fixed in the turn
// that published it, before the check answered, and the check then failed it. The check runs only in a page, so with
// none open the reply returns at once, as before (app-check-status.mjs). A result the reply carries isn’t sent again
// as a message: appCheck (apps.mjs) asks awaited() first. One the wait gave up on still comes as a message.

/** The check’s own time in the page, about 10 s, and its delivery. */
export const CHECK_WAIT_MS = 12_000;

/** Waits by `appId@version`: each resolves with the version’s check, or null when it gave up. */
/** @type {Map<string, Set<(check: any) => void>>} */
const waiting = new Map();
const key = (appId, version) => `${appId}@${version}`;
/**
 * Whether a page can run a check: one showing a conversation, in view, pinged in the last 20 seconds (Threads.anyViewing).
 * A page in a background tab runs no checks (app/js/app-check.mjs), so it doesn’t count. Set by server/index.mjs.
 */
let pagesOpen = () => false;

/** @param {() => boolean} fn */
export function checksRunIn(fn) {
  pagesOpen = fn;
}

/** Whether a tool’s reply is waiting for this version’s check: then the reply carries it. @param {string} appId @param {number} version */
export const awaited = (appId, version) => (waiting.get(key(appId, version))?.size ?? 0) > 0;

/** The version’s check has a result: every reply waiting for it has it. @param {string} appId @param {number} version @param {any} check */
export function settleWaits(appId, version, check) {
  for (const done of [...(waiting.get(key(appId, version)) ?? [])]) done(check);
}

/**
 * The app’s versions other than `current` won’t be checked: a newer one replaced them, or the app was retired. Every
 * reply waiting for one has that. @param {string} appId @param {number | null} current  null when the app was retired
 */
export function settleUnchecked(appId, current) {
  const status = current === null ? 'retired' : 'replaced';
  for (const k of [...waiting.keys()]) {
    const [id, v] = [k.slice(0, k.lastIndexOf('@')), Number(k.slice(k.lastIndexOf('@') + 1))];
    if (id === appId && v !== current) settleWaits(appId, v, { status, problems: [] });
  }
}

/**
 * The version’s check, once it has a result; null after `ms`, or when the call is cut off (`gone`: an AbortSignal or
 * the HTTP response).
 * @param {string} appId @param {number} version @param {{ ms?: number, gone?: any }} [o]
 * @returns {Promise<any>}
 */
export function waitForCheck(appId, version, { ms = CHECK_WAIT_MS, gone = null } = {}) {
  return new Promise((resolve) => {
    const k = key(appId, version);
    const set = waiting.get(k) ?? new Set();
    waiting.set(k, set);
    const done = (/** @type {any} */ check) => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) waiting.delete(k);
      resolve(check);
    };
    const timer = setTimeout(() => done(null), ms);
    timer.unref?.();
    if (typeof gone?.addEventListener === 'function') gone.addEventListener('abort', () => done(null), { once: true });
    else gone?.once?.('close', () => done(null));
    set.add(done);
  });
}

/** The problems a check found, one line each. @param {any} check */
const listed = (check) => (check.problems ?? []).map((/** @type {any} */ p) => `- ${p.code}: ${p.message}`).join('\n');

/**
 * What the reply adds about the version’s check: its result, or that it’s still running. @param {number} version
 * @param {any} check  the check, or null when the wait gave up
 */
export function checkLine(version, check) {
  const wait = `Don’t tell the person v${version} is fixed until its check passes.`;
  if (!check) return `v${version}’s check is still running; its result comes to you as a message. ${wait}`;
  if (check.status === 'passed') return `v${version} passed its check, and the person sees it.`;
  if (check.status === 'fixing')
    return `v${version}’s check found problems, so the person doesn’t see it yet. Fix them in a new version. ${wait}\n${listed(check)}`;
  if (check.status === 'replaced') return `v${version} was replaced by a newer version before its check ran.`;
  if (check.status === 'retired') return `The app was retired before v${version}’s check ran.`;
  if (check.status === 'crashed') return `v${version} still fails with a script error, so it shows as crashed:\n${listed(check)}`;
  return `v${version} is shown, with these notes from its check:\n${listed(check)}`;
}

/**
 * A show_app or update_app reply, with its check’s result once it has one, while a page is open to run it.
 * @param {string} name  the tool @param {any} r  its reply @param {any} gone  the call’s signal or response
 * @param {number} [ms]  how long to wait
 */
export async function withCheck(name, r, gone, ms = CHECK_WAIT_MS) {
  if ((name !== 'show_app' && name !== 'update_app') || !r?.ok || !r.appId || !Number.isInteger(r.version) || !pagesOpen()) return r;
  const check = await waitForCheck(r.appId, r.version, { gone, ms });
  return { ...r, check: check ?? r.check, message: `${r.message}\n\n${checkLine(r.version, check)}` };
}
