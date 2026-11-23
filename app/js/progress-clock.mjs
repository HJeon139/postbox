// A progress block’s times that move: “Updated 40 s ago”, live elapsed times, and stalled steps. Moved out of
// app/js/blocks.mjs, which draws the block and starts the clock.

import { formatDuration } from '/shared/text.mjs';
import { client } from './client.mjs';
import { dayOf, timeOf } from './dom.mjs';

/**
 * Whether a step still marked running has stopped going: its agent's turn has ended (finishedAt), with no background
 * job kept running for it, or the agent is gone. How long since its last update says nothing (#1715): a long step
 * under a live turn, one waiting on the person's card included, runs on. The server marks a step stalled at its turn's
 * end (stallSteps, turn-checks.mjs); this covers a turn that ended where it couldn't, such as a restart or a host's
 * turn interrupted. @param {string | undefined} sessionId
 */
function turnEnded(sessionId) {
  const se = sessionId ? client.state.sessions[sessionId] : null;
  if (!se) return true;
  const kept = (se.jobs ?? []).some((/** @type {any} */ j) => j.kept && j.state === 'running');
  return se.finishedAt != null && !kept;
}

/** Whether a progress block has a step still going, so its times move. @param {Element} node */
export const isRunning = (node) => node.querySelector('[data-since-kind="running"], [data-since-kind="stalled"]') !== null;

/**
 * Brings a progress block’s times up to date: “Updated 40 s ago”, live elapsed times, and stalled steps. A finished
 * block says when it was last updated, “Updated 9:14”, which never needs another tick.
 */
export function tickProgress(node) {
  const now = Date.now();
  const live = isRunning(node);
  const stale = turnEnded(node.dataset.progress);
  for (const el of node.querySelectorAll('[data-since]')) {
    const ms = Math.max(1000, now - Number(el.dataset.since));
    if (el.dataset.sinceKind === 'updated' && !live) {
      const at = Number(el.dataset.since);
      el.textContent = `Updated ${timeOf(at)}`;
      el.title = `${dayOf(at)} ${timeOf(at)}`;
    } else if (el.dataset.sinceKind === 'updated') el.textContent = ms < 5000 ? 'Updated just now' : `Updated ${formatDuration(ms)} ago`;
    else if (el.dataset.sinceKind === 'stalled' || stale)
      el.textContent = `No update for ${formatDuration(Math.max(1000, now - Number(node.dataset.updatedAt)))}`;
    else el.textContent = formatDuration(ms);
    const li = el.closest('li');
    if (li && el.dataset.sinceKind === 'running') {
      li.classList.toggle('stale', stale);
      li.querySelector('.g')?.setAttribute('aria-label', stale ? 'Stalled' : 'Running');
    }
  }
}

// The clock ticks only blocks with a step still going, once a second, and stops when none is left; drawing a block
// starts it again. Ticking every block rewrote each finished one’s “Updated … ago” every second, and a long conversation
// has many.
let progressClock = 0;
export function startProgressClock() {
  if (progressClock) return;
  progressClock = setInterval(() => {
    const blocks = [...document.querySelectorAll('[data-progress]')].filter(isRunning);
    for (const node of blocks) tickProgress(/** @type {HTMLElement} */ (node));
    if (!blocks.length) {
      clearInterval(progressClock);
      progressClock = 0;
    }
  }, 1000);
}
