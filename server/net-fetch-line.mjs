// What an app fetched with net.fetch, shown in its agent’s activity (#1482): one step per app per turn, naming the hosts
// and how often, such as “Visits fetched data.example.org ×3”. It’s transparency about data leaving, not an alarm: a
// step in the list of what the agent did, never a message, a needs-you, a notification or a focus move. While the
// agent’s turn runs it’s a step of that turn; otherwise it goes on the agent’s last reply in the app’s thread.

import { turnStep } from './step-text.mjs';

/**
 * Hosts each step counted, by its id, while Postbox runs: the newest COUNTS_KEPT steps’, oldest dropped first. A restart, or
 * a step dropped, starts its count again from the next fetch.
 */
const counts = new Map();
const COUNTS_KEPT = 500;

/** The step’s line: the app, then each host with its count past one. @param {string} title @param {Map<string, number>} hosts */
export function fetchLabel(title, hosts) {
  const each = [...hosts].map(([host, n]) => (n > 1 ? `${host} ×${n}` : host));
  return `${title} fetched ${each.join(', ')}`;
}

/** The reply a step goes on when no turn runs: the first part of the agent’s last reply there, with its turn’s id. */
function lastReply(apps, app) {
  const items = apps.store.pending.items(app.threadId);
  const last = items.findLast((/** @type {any} */ it) => it.kind === 'agent' && it.sessionId === app.sessionId && it.turnId);
  if (!last) return null;
  const first = items.find((/** @type {any} */ it) => it.kind === 'agent' && it.turnId === last.turnId && it.activity);
  return first ? { itemId: first.id, turnId: last.turnId, steps: first.activity.steps ?? [] } : null;
}

/**
 * Counts one fetch of an app’s, and shows it in its agent’s activity.
 * @param {import('./app-service.mjs').Apps} apps @param {any} app @param {string} host
 */
export function noteFetch(apps, app, host) {
  const turn = apps.running.turnOf(app.sessionId);
  const at = turn?.first ? { itemId: turn.first, turnId: turn.id, steps: turn.steps } : lastReply(apps, app);
  if (!at) return;
  const id = `net-fetch-${app.id}-${at.turnId}`;
  const hosts = counts.get(id) ?? new Map();
  hosts.set(host, (hosts.get(host) ?? 0) + 1);
  counts.delete(id);
  counts.set(id, hosts);
  if (counts.size > COUNTS_KEPT) counts.delete(counts.keys().next().value);
  const step = turnStep({
    id,
    label: fetchLabel(app.title, hosts),
    state: 'done',
    ms: null,
    who: null,
    parent: null,
    detail: null,
    kind: null,
    job: null,
    input: null,
    output: null,
  });
  if (turn?.first) {
    const i = turn.steps.findIndex((/** @type {any} */ s) => s.id === id);
    if (i >= 0) turn.steps[i] = { ...turn.steps[i], ...step };
    else turn.steps.push(step);
  }
  apps.store.emit('item.patch', { threadId: app.threadId, id: at.itemId, activityStep: step });
}
