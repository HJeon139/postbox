// An agent out of quota until a reset time (#442) is out of quota only until then (shared/agent-state.mjs), but no
// event comes when that time passes. So the page keeps one timer, at the soonest reset still ahead, and when it fires
// tells its listeners each of those sessions changed, as a session event does: the rings and the rows paint again.
// A session event looks at that session only, so a busy room doesn’t walk every session on each one.

import { client } from './client.mjs';

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
let soonest = Number.POSITIVE_INFINITY;
// Until when the page has painted resets: one passed before then was painted as passed already, so it isn’t again.
let painted = Date.now();

/** A reset still ahead, as the timer waits for it. @param {any} se */
const resetOf = (se) => {
  const until = se?.quota?.until;
  return typeof until === 'number' && until > Date.now() ? until : null;
};

/** Waits for a reset, if it comes before the one the timer waits for. @param {number} until */
function watch(until) {
  if (until >= soonest) return;
  if (timer) clearTimeout(timer);
  soonest = until;
  // setTimeout fires at once past its 32-bit limit, about 24 days; firing early only waits again.
  timer = setTimeout(reached, Math.min(until - Date.now(), 2 ** 31 - 1) + 50);
}

/** The timer fired: the sessions whose reset has passed paint again, and it waits for the next. */
function reached() {
  timer = null;
  soonest = Number.POSITIVE_INFINITY;
  const since = painted;
  painted = Date.now();
  for (const se of Object.values(client.state.sessions ?? {})) {
    const until = se.quota?.until;
    if (typeof until === 'number' && until > since && until <= painted) client.emit({ type: 'session', data: se });
    watchSession(se);
  }
}

/** Waits for a session’s reset, if it has one ahead. @param {any} se */
function watchSession(se) {
  const next = resetOf(se);
  if (next) watch(next);
}

client.on((ch) => {
  if (ch.type === 'session') watchSession(ch.data);
  else if (ch.type === 'load') for (const se of Object.values(client.state.sessions ?? {})) watchSession(se);
});
