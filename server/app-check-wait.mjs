// show_app and update_app wait for the version’s pre-display check while a Postbox page is open to run it, up to
// CHECK_WAIT_MS, and their reply carries its result (#337). Agents told the person a version was fixed in the turn
// that published it, before the check answered, and the check then failed it. The check runs only in a page, so with
// none open the reply returns at once, as before (app-check-status.mjs). A result the reply carries isn’t sent again
// as a message: appCheck (apps.mjs) asks awaited(apps, appId, version, turn) first, for the turn running now, so a
// wait left by a turn that ended doesn’t count as heard by the next one. One the wait gave up on still comes as
// a message. Each runtime owns its waits on apps.waiting, and checks whether a page is in view through apps.threads.

/** The check’s own time in the page, about 10 s, and its delivery. */
export const CHECK_WAIT_MS = 12_000;

const key = (appId, version) => `${appId}@${version}`;

/**
 * Whether a tool’s reply is waiting for this version’s check: then the reply carries it. Given a turn, only a reply
 * that turn is waiting on counts: the turn that will hear it.
 * @param {any} apps @param {string} appId @param {number} version @param {any} [turn]
 */
export function awaited(apps, appId, version, turn) {
  const set = apps?.waiting?.get(key(appId, version));
  if (!set?.size) return false;
  return turn === undefined || [...set].some((done) => done.turn === turn);
}

/**
 * The version’s check has a result: every reply waiting for it has it.
 * @param {any} apps @param {string} appId @param {number} version @param {any} check
 */
export function settleWaits(apps, appId, version, check) {
  for (const done of [...(apps?.waiting?.get(key(appId, version)) ?? [])]) done(check);
}

/**
 * The app’s versions other than `current` won’t be checked: a newer one replaced them, or the app was retired. Every
 * reply waiting for one has that.
 * @param {any} apps @param {string} appId @param {number | null} current  null when the app was retired
 */
export function settleUnchecked(apps, appId, current) {
  const status = current === null ? 'retired' : 'replaced';
  for (const k of [...(apps?.waiting?.keys() ?? [])]) {
    const [id, v] = [k.slice(0, k.lastIndexOf('@')), Number(k.slice(k.lastIndexOf('@') + 1))];
    if (id === appId && v !== current) settleWaits(apps, appId, v, { status, problems: [] });
  }
}

/** Whether a signal or HTTP response is already aborted or closed. @param {any} g */
const closed = (g) => g?.aborted === true || g?.destroyed === true || g?.writableEnded === true || g?.closed === true;

/**
 * The version’s check, once it has a result; null after `ms`, or when the call or turn is cut off (`gone`: an
 * AbortSignal, an HTTP response, or a list of them). If the check already settled before the wait started, returns it
 * at once.
 * @param {any} apps @param {string} appId @param {number} version
 * @param {{ ms?: number, gone?: any, turn?: any }} [o]  turn: the turn the call is in, which hears the result
 * @returns {Promise<any>}
 */
export function waitForCheck(apps, appId, version, { ms = CHECK_WAIT_MS, gone = null, turn = null } = {}) {
  const app = apps?.store?.pending?.apps?.()?.[appId];
  if (app && app.current === version && app.check?.status && app.check.status !== 'pending') return Promise.resolve(app.check);
  const sources = (Array.isArray(gone) ? gone : [gone]).filter(Boolean);
  if (sources.some(closed)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiting = (apps.waiting ??= new Map());
    const k = key(appId, version);
    const set = waiting.get(k) ?? new Set();
    waiting.set(k, set);
    // Each wait’s listeners go when it settles, so a turn’s signal doesn’t gather one per call.
    const off = new AbortController();
    const cut = () => done(null);
    const done = Object.assign(
      (/** @type {any} */ check) => {
        clearTimeout(timer);
        off.abort();
        for (const g of sources) if (typeof g.addEventListener !== 'function') g.off?.('close', cut);
        set.delete(done);
        if (!set.size) waiting.delete(k);
        resolve(check);
      },
      { turn },
    );
    const timer = setTimeout(cut, ms);
    for (const g of sources) {
      if (typeof g.addEventListener === 'function') g.addEventListener('abort', cut, { once: true, signal: off.signal });
      else g.once?.('close', cut);
    }
    set.add(done);
  });
}

/** The problems a check found, one line each. @param {any} check */
const listed = (check) => (check.problems ?? []).map((/** @type {any} */ p) => `- ${p.code}: ${p.message}`).join('\n');

/**
 * What the reply adds about the version’s check: its result, or that it’s still running. @param {number} version
 * @param {any} check  the check, or null when the wait gave up @param {string} [appId]
 */
export function checkLine(version, check, appId = 'the app') {
  const wait = `Don’t tell the person v${version} is fixed until its check passes.`;
  if (!check) return `v${version}’s check is still running; problems come to you as a message, and read_message { id: "${appId}" } reads the result. ${wait}`;
  if (check.status === 'passed') return `v${version} passed its check, and the person sees it.`;
  if (check.status === 'fixing')
    return `v${version}’s check found problems, so the person doesn’t see it yet. Fix them in a new version. ${wait}\n${listed(check)}`;
  if (check.status === 'replaced') return `v${version} was replaced by a newer version before its check ran.`;
  if (check.status === 'retired') return `The app was retired before v${version}’s check ran.`;
  if (check.status === 'crashed') return `v${version} still fails with a script error, so it shows as crashed:\n${listed(check)}`;
  if (!check.notes) return `v${version} still has problems from its check, so it is shown with a note:\n${listed(check)}`;
  return `v${version} is shown, with these notes from its check:\n${listed(check)}`;
}

/**
 * A show_app or update_app reply, with its check’s result once it has one, while a page is open to run it.
 * @param {any} apps  the Apps service (or Runtime, whose .apps is read)
 * @param {string} name  the tool @param {any} r  its reply @param {any} gone  the call’s signal or response
 * @param {any} [turn]  the turn the call is in: its stop releases the wait, and only it hears the result
 * @param {number} [ms]  how long to wait
 */
export async function withCheck(apps, name, r, gone, turn = null, ms = CHECK_WAIT_MS) {
  const svc = apps?.apps ?? apps;
  if ((name !== 'show_app' && name !== 'update_app') || !r?.ok || !r.appId || !Number.isInteger(r.version) || !svc?.threads?.anyViewing?.()) return r;
  const check = await waitForCheck(svc, r.appId, r.version, { gone: [gone, turn?.abort?.signal].flat(), ms, turn });
  const base = check ? r.message.replace(`; browser check: ${r.check?.status ?? 'pending'}. This does not confirm a rendered result.`, '.') : r.message;
  return { ...r, check: check ?? r.check, message: `${base}\n\n${checkLine(r.version, check, r.appId)}` };
}
