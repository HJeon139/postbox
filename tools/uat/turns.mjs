// How the runner waits on the agents’ turns between steps, and stops one when the tester asks it to.

import { js, sleep } from '../browser.mjs';
import { waitingOnYou } from './checks.mjs';

/** The longest the tester’s wait action waits: five minutes. */
export const WAIT_MAX_S = 300;
/**
 * The longest send_then_stop waits before Stop. The delay is the tester’s wait before it presses Stop, so it gets the
 * wait action’s bound: long enough for a turn to start a background job and check on it (p0 asks for 40 s), and short
 * enough that a mistaken number can’t hold the run while an agent spends unwatched.
 */
export const STOP_AFTER_MAX_S = WAIT_MAX_S;
/**
 * The longest a wait the tester chooses runs, unless its phase asks for a longer one in so many words (namedWait). The
 * tester waits while an agent works, and the next step waits on that agent’s turn anyway, so a longer wait only holds
 * the run: in the runs of 28 to 30 October it chose 20 and 30 s, and the one 60 s wait was its phase’s “a minute apart”.
 */
export const TESTER_WAIT_S = 30;
/**
 * How long a block that asks may sit while its agent still works before the wait hands it to the tester. In the
 * recorded runs of 24 October, the turns that showed one ended 2.5 to 4.3 s after it (12 blocks in 6 runs), most on a
 * closing line: handing those back at once would show the tester a reply still being written. A turn still at work
 * 10 s on is doing more, and the tester can answer meanwhile. Stop’s question hands back at once: the turn waits on it.
 */
export const BLOCK_GRACE_MS = 10_000;

/** What needs the person, by a key that names each once: Stop’s questions about background jobs, then waitingOnYou’s. */
const asking = (st, ids, sessions) => [
  ...sessions
    .filter((se) => se.stopAsk)
    .map((se) => ({
      key: `stop:${se.id}:${se.stopAsk.at}`,
      stop: true,
      what: `Postbox asks whether to stop @${se.handle}’s ${se.stopAsk.jobs > 1 ? 'background jobs' : 'background job'} too`,
    })),
  ...waitingOnYou(st, ids).map((w) => ({ key: w.itemId ?? w.what, stop: false, what: w.what })),
];

/**
 * Of the asks on screen, those to hand the tester now, while an agent works: Stop’s question at once, a block once it
 * has waited BLOCK_GRACE_MS. `told` holds what the tester has had or will have anyway: what was handed back, and what
 * was on screen while nobody worked. `since` holds when this wait first saw each of the others.
 * @param {{ key: string, stop: boolean }[]} asks  @param {{ told: Set<string>, since: Map<string, number>, working: boolean }} o
 */
function dueAsks(asks, { told, since, working }) {
  if (!working) {
    for (const x of asks) told.add(x.key);
    return [];
  }
  const now = Date.now();
  for (const x of asks) if (!told.has(x.key) && !since.has(x.key)) since.set(x.key, now);
  const due = asks.filter((x) => !told.has(x.key) && (x.stop || now - (since.get(x.key) ?? now) >= BLOCK_GRACE_MS));
  if (due.length) for (const x of asks) told.add(x.key);
  return due;
}

/**
 * Waits until no agent under test is working, sampling what the screen says meanwhile. With `handBack`, it returns
 * while an agent still works once something needs the person that the tester hasn’t had: Stop’s question about a
 * background job, which keeps the turn running until it’s answered (#126), or a block that asks and has waited
 * BLOCK_GRACE_MS. The tester gets it then, rather than when the turn ends (#289), once for each (dueAsks).
 * @param {{ api: any, d: any, threadsUnderTest: any, facts: any, midTurnChecks: any, opt: any, told?: Set<string>, handBack?: boolean, log?: (line: string) => void }} ctx
 */
export async function settle({ api, d, threadsUnderTest, facts, midTurnChecks, opt, told = new Set(), handBack = false, log = () => {} }) {
  const end = Date.now() + Number(opt['turn-timeout']) * 1000;
  let calm = 0;
  const since = new Map();
  while (Date.now() < end) {
    await sleep(1500);
    const st = (await api('/api/state')).state;
    const ids = threadsUnderTest(st);
    const sessions = ids
      .flatMap((t) => st.threads[t]?.members ?? [])
      .map((id) => st.sessions[id])
      .filter(Boolean);
    const working = sessions.filter((se) => ['think', 'tool', 'gen'].includes(se.state));
    const checking = Object.values(st.apps).some((a) => ids.includes(a.threadId) && ['pending', 'fixing'].includes(a.check?.status));
    const thinking = working.filter((se) => se.state !== 'gen').map((se) => se.handle);
    if (thinking.length) facts.samples.push({ busy: thinking, rows: (await d.working()).length });
    const due = handBack ? dueAsks(asking(st, ids, sessions), { told, since, working: working.length > 0 }) : [];
    if (due.length) {
      log(`handed back while @${working.map((se) => se.handle).join(', @')} works: ${due.map((x) => x.what).join('; ')}`);
      return null;
    }
    if (working.length) await midTurnChecks(st);
    calm = working.length || checking ? 0 : calm + 1;
    if (calm >= 2) return null;
  }
  await d.stopAll();
  return `An agent was still working after ${opt['turn-timeout']} s, so the run pressed Stop.`;
}

/**
 * The tester’s send_then_stop: sends a message, waits the seconds it gave (at most STOP_AFTER_MAX_S), running `onWait`
 * every 5 s meanwhile, presses Stop on the active reply, and reads Postbox’s question about background jobs if it asks
 * one, for the tester to answer with jobs. A reply that finished first is said, not an error. The interrupt goes on the
 * run’s record (probes.interrupts) and in its log.
 * @param {any} d  @param {{ text?: string, seconds?: number }} a
 * @param {{ step: number, probes: { interrupts: any[] }, log?: (line: string) => void, onWait?: () => Promise<void> }} run
 * @returns {Promise<string>}  what happened, for the tester
 */
export async function sendThenStop(d, a, { step, probes, log = () => {}, onWait = async () => {} }) {
  const n = Number(a.seconds ?? 2);
  const asked = Number.isFinite(n) ? Math.round(n) : 2;
  const seconds = Math.max(1, Math.min(STOP_AFTER_MAX_S, asked));
  const clamped = seconds !== asked ? ` (you asked for ${asked} s; the run waits 1 to ${STOP_AFTER_MAX_S} s)` : '';
  await d.send(a.text ?? '');
  for (let left = seconds * 1000; left > 0; left -= 5000) {
    await sleep(Math.min(5000, left));
    if (left > 5000) await onWait();
  }
  const stopped = await d.stopAll().then(
    () => true,
    (e) => (/No Stop control/.test(e.message) ? false : Promise.reject(e)),
  );
  let ask = null;
  for (let i = 0; stopped && i < 20 && !(ask = await d.jobsAsk()); i++) await sleep(250);
  probes.interrupts.push({ step, at: Date.now(), do: 'stop', after: seconds, stopped, asked: ask ?? null, answered: null });
  const said = !stopped
    ? `No reply was working after ${seconds} s${clamped}, so nothing was stopped: it had finished.`
    : `Pressed Stop on the active reply after ${seconds} s${clamped}. ${ask ? `Postbox asks: “${ask}” Answer it with jobs.` : 'Postbox didn’t ask about background jobs.'}`;
  log(`send_then_stop: ${said}`);
  return said;
}

const units = (n, unit) => (/^(?:a|one)$/i.test(n) ? 1 : Number(n)) * (/^min/i.test(unit) ? 60 : 1);

/**
 * The longest wait a phase’s text asks for in so many words, in seconds, or 0: “a wait of 180 seconds”, “wait 70
 * seconds”, “wait more than a minute”, “twice, a minute apart”.
 * @param {string} text
 */
export function namedWait(text) {
  const asked = [
    ...String(text ?? '').matchAll(/\bwait(?: of| for)?(?: more than)? (\d+|a|one) (seconds?|minutes?)\b/gi),
    ...String(text ?? '').matchAll(/\b(\d+|a|one) (seconds?|minutes?) apart\b/gi),
  ];
  return Math.min(WAIT_MAX_S, Math.max(0, ...asked.map((m) => units(m[1], m[2]))));
}

/** Whether no agent under test is at a turn and no app of theirs is being checked: what settle waits for. */
export function settledNow(st, ids) {
  const busy = ids.flatMap((t) => st.threads[t]?.members ?? []).some((id) => ['think', 'tool', 'gen'].includes(st.sessions[id]?.state));
  return !busy && !Object.values(st.apps ?? {}).some((a) => ids.includes(a.threadId) && ['pending', 'fixing'].includes(a.check?.status));
}

/**
 * The tester’s wait action. In a phase that asks for a wait in so many words (namedWait), it runs the seconds asked, up
 * to the longest the phase names: those waits hold the room on purpose, such as a card left open. Otherwise it runs at
 * most TESTER_WAIT_S, and ends once the agents under test have settled for two reads 1.5 s apart, as settle does.
 * @param {{ seconds?: number }} a  @param {{ named: number, api: (path: string) => Promise<any>, threadsUnderTest: (st: any) => string[] }} o
 * @returns {Promise<string>}  what happened, for the tester, when it wasn’t the wait asked for
 */
export async function testerWait(a, { named, api, threadsUnderTest }) {
  const n = Math.round(Number(a.seconds ?? 30));
  const asked = Number.isFinite(n) && n > 0 ? n : 30;
  const most = Math.min(WAIT_MAX_S, Math.max(TESTER_WAIT_S, named));
  const seconds = Math.min(asked, most);
  const capped = seconds < asked ? ` You asked for ${asked} s; the run waits at most ${most} s unless the phase asks for longer.` : '';
  const start = Date.now();
  const end = start + seconds * 1000;
  for (let calm = 0; Date.now() < end; ) {
    await sleep(Math.min(1500, end - Date.now()));
    if (named || Date.now() >= end) continue;
    const st = (await api('/api/state')).state;
    calm = settledNow(st, threadsUnderTest(st)) ? calm + 1 : 0;
    if (calm >= 2) return `Waited ${Math.round((Date.now() - start) / 1000)} s of ${seconds}: no agent was working, so the wait ended early.${capped}`;
  }
  return capped ? `Waited ${seconds} s.${capped}` : '';
}

/**
 * Stops a session’s turn, and its background jobs, through the page’s own request, as its Stop does: the run budget
 * names the turn to stop, which the composer’s Stop can’t (it stops the agent that spoke last), nor one in a thread
 * that isn’t open.
 * @param {any} page  from tools/browser.mjs launch()
 */
export const stopThroughPage = (page) => (/** @type {string} */ id) =>
  page.evaluate(
    `fetch(${js(`/api/sessions/${encodeURIComponent(id)}/stop`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobs: 'stop' }) }).then((r) => r.ok)`,
  );

/**
 * With a run budget (tools/uat/budget.mjs), every 1.5 s until it’s ended, whatever the run is doing (the tester’s
 * step, a wait, an interrupt): reads which agents are at a turn, and stops each turn the budget says to. Returns the
 * function that ends it. Without a budget, it does nothing.
 * @param {{ budget: any, api: (path: string) => Promise<any>, threadsUnderTest: (st: any) => string[], stop: (id: string) => Promise<unknown>, log?: (line: string) => void, every?: number }} o
 */
export function watchBudget({ budget, api, threadsUnderTest, stop, log = () => {}, every = 1500 }) {
  if (!budget.on) return () => {};
  let ended = false;
  let failed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const poll = async () => {
    try {
      const st = (await api('/api/state')).state;
      const working = threadsUnderTest(st)
        .flatMap((t) => st.threads[t]?.members ?? [])
        .map((id) => st.sessions[id])
        .filter((se) => se && ['think', 'tool', 'gen'].includes(se.state));
      for (const id of budget.duringTurns(working.map((se) => ({ id: se.id, handle: se.handle })))) {
        log(`budget: stopping @${st.sessions[id]?.handle ?? id}’s turn`);
        await stop(id);
      }
    } catch (e) {
      if (!failed) log(`The run’s budget couldn’t check the agents’ turns, and will keep trying: ${e.message}`);
      failed = true;
    }
    if (!ended) timer = setTimeout(poll, every);
  };
  timer = setTimeout(poll, every);
  return () => {
    ended = true;
    clearTimeout(timer);
  };
}
