// The composer’s quota line (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”):
// one bar for each backend the room’s agents run on, with its most-used window and when it resets, in the one row under
// the conversation’s input (#1437), which a hint takes while it applies. A quota is a backend’s, shared by its agents,
// so a bar is labeled with the backend, never an agent; running out shows in the agent’s row (agents.mjs), not here.
// A backend that reports no usage gets no bar. A figure seen over an hour ago says its age, and a window past its reset
// shows no number, so an old figure is never shown as current.

import { BACKEND_NAMES } from '/shared/agent-facts.mjs';
import { quotaKeyOf } from '/shared/quota-key.mjs';
import { client, sessionsOf } from './client.mjs';
import { h } from './dom.mjs';
import { onChangeWhileAlive, WeakElements } from './held-weakly.mjs';

const S = () => client.state;
const HOUR = 3_600_000;
const STALE_MS = HOUR;
const REPAINT_ON = new Set(['quota', 'persona', 'session', 'thread', 'host', 'load']);
const lines = new WeakElements();

/** The room’s quotas with a report, one per key, in the order its agents first use them. @param {string} threadId */
function quotasIn(threadId) {
  const keys = new Set(sessionsOf(threadId).flatMap((se) => (se.retiredFork ? [] : [quotaKeyOf(S().personas[se.personaId])])));
  return [...keys].map((key) => S().quota?.[key]).filter(Boolean);
}

/** How long ago, in words: “25 min”, “2 h”, “3 d”. @param {number} ms */
function age(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 24 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / (24 * HOUR))} d`;
}

/** “3:10 pm”, or “Tue 3:10 pm” a day or more away. @param {number} at @param {number} now */
function resetTime(at, now) {
  const opts = /** @type {Intl.DateTimeFormatOptions} */ ({ hour: 'numeric', minute: '2-digit', ...(at - now >= 24 * HOUR ? { weekday: 'short' } : {}) });
  return new Date(at).toLocaleString('en-US', opts).replace(/\s?([AP])M$/, (_m, p) => ` ${p.toLowerCase()}m`);
}

/**
 * What one bar says: its most-used window that hasn’t reset, else the first, which has. Its main part (the backend, the
 * percent and a stale figure’s age) stays whole on a phone’s row, and the rest (the window and its reset) gives way
 * first, since a phone has no tooltip. @param {any} q @param {number} now
 * @returns {{ label: string, pct: number | null, main: string, more: string, text: string, stale: boolean }}
 */
export function barOf(q, now) {
  const name = BACKEND_NAMES[q.backend] ?? q.backend;
  const label = q.host ? `${name} on ${S().hosts?.[q.host]?.name ?? 'its host'}` : name;
  const live = q.windows.filter((w) => !w.resetsAt || w.resetsAt > now);
  const top = live.reduce((a, w) => (!a || w.used > a.used ? w : a), null);
  const stale = now - q.seenAt > STALE_MS;
  const ago = stale ? ` · as of ${age(now - q.seenAt)} ago` : '';
  if (!top) {
    const more = ` · ${q.windows[0]?.name ?? ''} reset`;
    return { label, pct: null, main: `${label}${ago}`, more, text: `${label}${more}${ago}`, stale };
  }
  const pct = Math.round(top.used * 100);
  const more = ` of ${top.name}${top.resetsAt ? ` · resets ${resetTime(top.resetsAt, now)}` : ''}`;
  return { label, pct, main: `${label} ${pct}%${ago}`, more, text: `${label} ${pct}%${more}${ago}`, stale };
}

/** One bar, as a meter: its fill in the neutral color, never an alarm’s. @param {ReturnType<typeof barOf>} b */
function barEl(b) {
  return h(
    'div.quota-bar',
    {
      role: 'meter',
      class: b.stale ? 'stale' : '',
      'aria-label': `${b.label} quota`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(b.pct ?? 0),
      'aria-valuetext': b.text,
      title: b.text,
    },
    h('span.quota-track', { 'aria-hidden': 'true' }, h('span.quota-fill', { style: { width: `${b.pct ?? 0}%` } })),
    h('span.quota-main', { 'aria-hidden': 'true' }, b.main),
    h('span.quota-more', { 'aria-hidden': 'true' }, b.more),
  );
}

/** Draws the line again, only when what it says changed. @param {HTMLElement} el */
function paint(el) {
  const bars = quotasIn(el.dataset.quotaLine ?? '').map((q) => barOf(q, Date.now()));
  const said = JSON.stringify(bars);
  if (el.dataset.said === said) return;
  el.dataset.said = said;
  el.replaceChildren(...bars.map(barEl));
}

/** The conversation’s quota line, which paints itself as reports and the room change. @param {string} threadId */
export function quotaLine(threadId) {
  const el = h('div.quota-line', { role: 'group', 'aria-label': 'Quota by backend', dataset: { quotaLine: threadId } });
  paint(el);
  lines.add(el);
  onChangeWhileAlive(el, (live, change) => REPAINT_ON.has(change.type) && paint(live));
  return el;
}

// Ages and resets move with the clock, not with events: each minute, every line on the page says what’s true now.
setInterval(() => {
  for (const el of lines) if (el.isConnected) paint(el);
}, 60_000);
