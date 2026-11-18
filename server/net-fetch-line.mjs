// What an app fetched with net.fetch, shown in its agent’s activity (#1482): one step per app per turn, naming the hosts
// and how often, such as “Visits fetched data.example.org ×3; tried 10.0.0.1 (refused)”. Every attempt counts, refused,
// failed and timed out too, since a lookup or a refused request can still carry data out. It’s transparency about data
// leaving, not an alarm: a step in the list of what the agent did, never a message, a needs-you, a notification or a
// focus move. While the agent’s turn runs it’s a step of that turn; otherwise it goes on the agent’s last reply in the
// app’s thread. A polling app patches that reply at most once per PATCH_MS, so it can’t grow the event log with every
// fetch.

import { turnStep } from './step-text.mjs';

/** @typedef {'fetched' | 'refused' | 'failed' | 'timed out'} Outcome */

/**
 * What each step counted, by its id, while Postbox runs: outcome → host → count, the newest COUNTS_KEPT steps’, oldest
 * dropped first. A restart, or a step dropped, starts its count again from the next fetch.
 * @type {Map<string, Map<Outcome, Map<string, number>>>}
 */
const counts = new Map();
const COUNTS_KEPT = 500;
/** Hosts one step names; past them, a new host counts as “other hosts”. */
const HOSTS_KEPT = 20;
const OTHER = 'other hosts';

/** The least time between two patches of one step, in ms: the first fetch shows at once, the rest when it ends. */
export const PATCH_MS = 5000;
/** @type {Map<string, any>} step id → the patch due when its wait ends, or null when none is */
const waiting = new Map();

/** What a fetch came to, from what net.fetch threw, or nothing when it answered. @param {any} [error] @returns {Outcome} */
export function outcomeOf(error) {
  if (!error) return 'fetched';
  if (error.status === 504) return 'timed out';
  if (error.status === 400 || error.status === 403 || error.status === 429) return 'refused';
  return 'failed';
}

/**
 * The step’s line: the app, each host it fetched with its count past one, then each it tried and didn’t get, and why.
 * @param {string} title @param {Map<Outcome, Map<string, number>>} tries
 */
export function fetchLabel(title, tries) {
  const named = (/** @type {Map<string, number>} */ hosts, why = '') => [...hosts].map(([host, n]) => `${host}${n > 1 ? ` ×${n}` : ''}${why && ` (${why})`}`);
  const fetched = named(tries.get('fetched') ?? new Map());
  const tried = [...tries].filter(([outcome]) => outcome !== 'fetched').flatMap(([outcome, hosts]) => named(hosts, outcome));
  const parts = [];
  if (fetched.length) parts.push(`fetched ${fetched.join(', ')}`);
  if (tried.length) parts.push(`tried ${tried.join(', ')}`);
  return `${title} ${parts.join('; ')}`;
}

/** The reply a step goes on when no turn runs: the first part of the agent’s last reply there, with its turn’s id. */
function lastReply(apps, app) {
  const items = apps.store.pending.items(app.threadId);
  const mine = (/** @type {any} */ it) => it.kind === 'agent' && it.sessionId === app.sessionId && it.turnId;
  const last = items.findLast(mine);
  if (!last) return null;
  const first = items.find((/** @type {any} */ it) => mine(it) && it.turnId === last.turnId);
  return { itemId: first.id, turnId: last.turnId };
}

/** Counts one attempt in a step’s tally. @param {string} id @param {Outcome} outcome @param {string} host */
function count(id, outcome, host) {
  const tries = counts.get(id) ?? new Map();
  const hosts = tries.get(outcome) ?? new Map();
  const total = [...tries.values()].reduce((n, h) => n + h.size, 0);
  const key = hosts.has(host) || total < HOSTS_KEPT ? host : OTHER;
  hosts.set(key, (hosts.get(key) ?? 0) + 1);
  tries.set(outcome, hosts);
  counts.delete(id);
  counts.set(id, tries);
  if (counts.size > COUNTS_KEPT) counts.delete(counts.keys().next().value);
  return tries;
}

/** Emits a step’s patch now, or keeps the latest for when its wait ends. @param {any} store @param {any} patch */
function throttled(store, patch) {
  const id = patch.activityStep.id;
  if (waiting.has(id)) {
    waiting.set(id, patch);
    return;
  }
  store.emit('item.patch', patch);
  waiting.set(id, null);
  const timer = setTimeout(() => {
    const due = waiting.get(id);
    waiting.delete(id);
    if (due) throttled(store, due);
  }, PATCH_MS);
  timer.unref?.();
}

/**
 * Counts one attempt of an app’s, and shows it in its agent’s activity.
 * @param {import('./app-service.mjs').Apps} apps @param {any} app @param {string} host @param {Outcome} outcome
 */
export function noteFetch(apps, app, host, outcome) {
  const turn = apps.running.turnOf(app.sessionId);
  const at = turn?.first ? { itemId: turn.first, turnId: turn.id } : lastReply(apps, app);
  if (!at) return;
  const id = `net-fetch-${app.id}-${at.turnId}`;
  const label = fetchLabel(app.title, count(id, outcome, host));
  const step = turnStep({ id, label, state: 'done', ms: null, who: null, parent: null, detail: null, kind: null, job: null, input: null, output: null });
  if (turn?.first) {
    const i = turn.steps.findIndex((/** @type {any} */ s) => s.id === id);
    if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step };
    else turn.steps.push(step);
  }
  throttled(apps.store, { threadId: app.threadId, id: at.itemId, activityStep: step });
}
