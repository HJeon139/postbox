// A progress block’s times that move: “Updated 40 s ago”, live elapsed times, and stalled steps. Moved out of
// app/js/blocks.mjs, which draws the block and starts the clock.

import { formatDuration } from '/shared/text.mjs';
import { client } from './client.mjs';
import { dayOf, timeOf } from './dom.mjs';

/** A step still marked running looks stalled when its agent has stopped working and the block hasn’t moved for a minute. */
const STALE_MS = 60000;
const WORKING = new Set(['think', 'gen', 'tool']);

/** Whether a progress block has a step still going, so its times move. @param {Element} node */
export const isRunning = (node) => node.querySelector('[data-since-kind="running"], [data-since-kind="stalled"]') !== null;

/**
 * Brings a progress block’s times up to date: “Updated 40 s ago”, live elapsed times, and stalled steps. A finished
 * block says when it was last updated, “Updated 9:14”, which never needs another tick.
 */
export function tickProgress(node) {
  const now = Date.now();
  const live = isRunning(node);
  const se = client.state.sessions[node.dataset.progress];
  const idle = !se || !WORKING.has(se.state);
  const stale = idle && now - Number(node.dataset.updatedAt) > STALE_MS;
  for (const el of node.querySelectorAll('[data-since]')) {
    const ms = Math.max(1000, now - Number(el.dataset.since));
    const li = el.closest('li');
    if (el.dataset.sinceKind === 'updated' && !live) {
      const at = Number(el.dataset.since);
      el.textContent = `Updated ${timeOf(at)}`;
      el.title = `${dayOf(at)} ${timeOf(at)}`;
    } else if (el.dataset.sinceKind === 'updated') el.textContent = ms < 5000 ? 'Updated just now' : `Updated ${formatDuration(ms)} ago`;
    else if (el.dataset.sinceKind === 'stalled' || stale)
      el.textContent = `No update for ${formatDuration(Math.max(1000, now - Number(node.dataset.updatedAt)))}`;
    else el.textContent = formatDuration(ms);
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
