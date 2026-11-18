// The composer’s quota line (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the composer”):
// one bar for each backend the room’s agents run on, with its most-used window and when it resets, in the one row under
// the conversation’s input (#1437), which a hint takes while it applies. A quota is a backend’s, shared by its agents,
// so a bar is labeled with the backend, never an agent; running out shows in the agent’s row (agents.mjs), not here.
// A backend that reports no usage gets no bar. A figure seen over an hour ago is marked “~” and says its age, and a
// window past its reset shows no number, so an old figure is never shown as current. How the bars fit the row is
// quota-fit.mjs’s, from the line’s width as a ResizeObserver reports it, so painting reads no layout.

import { BACKEND_NAMES } from '/shared/agent-facts.mjs';
import { quotaKeyOf } from '/shared/quota-key.mjs';
import { fontOf, textWidth } from './canvas-font.mjs';
import { client, sessionsOf } from './client.mjs';
import { h, icon } from './dom.mjs';
import { onChangeWhileAlive, WeakElements } from './held-weakly.mjs';
import { fitBars, namesAt } from './quota-fit.mjs';
import { age, resetTime } from './quota-words.mjs';

const S = () => client.state;
const HOUR = 3_600_000;
const STALE_MS = HOUR;
const REPAINT_ON = new Set(['quota', 'persona', 'session', 'thread', 'host', 'load']);
const lines = new WeakElements();
/** The line’s last width and font: a line mounted again, as going back to a room does, starts measured (#1155). */
let room = { width: 0, font: '' };
/** A text’s width in the line’s font. @param {string} text */
const measure = (text) => textWidth(text, room.font);

/** The room’s quotas with a report, one per key, in the order its agents first use them. @param {string} threadId */
function quotasIn(threadId) {
  const keys = new Set(sessionsOf(threadId).flatMap((se) => (se.retiredFork ? [] : [quotaKeyOf(S().personas[se.personaId])])));
  return [...keys].map((key) => S().quota?.[key]).filter(Boolean);
}

/**
 * What one bar says: its most-used window that hasn’t reset, else the first, which has. A window is as fresh as the last
 * report that carried it, since a harness’s update can leave a window out. It shows its name, percent and window (brief);
 * its label (text) goes on with a limit that isn’t the default one, a host, a stale figure’s age, and the reset last.
 * @param {any} q @param {number} now
 */
export function barOf(q, now) {
  const full = BACKEND_NAMES[q.backend] ?? q.backend;
  const hostName = q.host ? (S().hosts?.[q.host]?.name ?? 'its host') : null;
  const where = hostName ? ` on ${hostName}` : '';
  const live = q.windows.filter((w) => !w.resetsAt || w.resetsAt > now);
  const top = live.reduce((a, w) => (!a || w.used > a.used ? w : a), null);
  const seen = (top ?? q.windows[0])?.seenAt ?? q.seenAt;
  const stale = now - seen > STALE_MS;
  const ago = stale ? `, as of ${age(now - seen)} ago` : '';
  const pct = top ? Math.round(top.used * 100) : null;
  const shown = top ? `${stale ? '~' : ''}${pct}%` : 'reset';
  const limit = top?.limit ? ` (${top.limitName ?? top.limit})` : '';
  const more = top
    ? ` of ${top.name}${limit}${where}${ago}${top.resetsAt ? ` · resets ${resetTime(top.resetsAt, now)}` : ''}`
    : ` · ${q.windows[0]?.name ?? ''}${where}${ago}`;
  const text = top ? `${full} ${pct}%${more}` : `${full}${more} reset`;
  // What it shows is the window alone; the rest is in its label, and in Settings › Backends (#1496).
  const brief = ` ${top ? 'of' : '·'} ${(top ?? q.windows[0])?.name ?? ''}`;
  return { backend: q.backend, full, host: hostName, label: `${full}${where}`, pct, shown, brief, text, stale };
}

/**
 * One bar, as a meter, drawn as the fit says: a track that fills its part of the line, in the neutral color, never an
 * alarm’s, with its words below it, at the last level its percent alone. It keeps the names it would show at the full
 * and the short level (data-names), for a check to hold the order the levels go in.
 * @param {ReturnType<typeof barOf>} b @param {any} fit @param {[string | null, string | null]} names
 */
function barEl(b, fit, names, /** @type {string} */ name) {
  return h(
    'div.quota-bar',
    {
      role: 'meter',
      dataset: { names: JSON.stringify(names) },
      'aria-label': `${b.label} quota`,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(b.pct ?? 0),
      'aria-valuetext': b.text,
      // “~” is explained where it’s read: a stale figure’s words say its age.
      title: b.stale ? `${b.text} (~: over an hour old)` : b.text,
    },
    h('span.quota-track', { 'aria-hidden': 'true' }, h('span.quota-fill', { style: { width: `${b.pct ?? 0}%` } })),
    h(
      'span.quota-text',
      { 'aria-hidden': 'true' },
      h('span.quota-name', name ? `${name} ` : ''),
      h('span.quota-pct', b.shown),
      fit.level < 2 ? h('span.quota-more', b.brief) : null,
    ),
  );
}

/** Draws the line again, only when what it says changed, with the button that opens its details at its end. @param {HTMLElement} el */
function paint(el) {
  const bars = quotasIn(el.dataset.quotaLine ?? '').map((q) => barOf(q, Date.now()));
  const given = bars.map((b) => ({ backend: b.backend, full: b.full, host: b.host, pct: b.shown }));
  const fit = fitBars(given, room.width - OPEN_W, measure);
  const said = JSON.stringify([bars, fit]);
  if (el.dataset.said === said) return;
  el.dataset.said = said;
  el.dataset.fit = String(fit.level);
  const [full, short] = [namesAt(given, false), namesAt(given, true)];
  el.replaceChildren(...bars.map((b, i) => barEl(b, fit, [full?.[i] ?? null, short?.[i] ?? null], fit.names[i])), ...(bars.length ? [opens.get(el)] : []));
}

/** The lines observed: one per composer on the page, and none left behind by a room switch. @type {Set<Element>} */
const observed = new Set();
export const observedLines = () => observed.size;
/** Lets go of a line taken off the page. @param {Element} el */
function forget(el) {
  resized.unobserve(el);
  observed.delete(el);
}
/**
 * Lets go of a line when its composer goes, so neither the observer nor this module holds it, or the room it was drawn
 * in (#866). A line hidden as it leaves, empty or behind a hint, reports no resize to go by. @param {Element | null} el
 */
export function releaseQuotaLine(el) {
  if (!el) return;
  forget(el);
  lines.delete(/** @type {HTMLElement} */ (el));
}

/**
 * The line’s width, when it changes; its first report changes nothing for a line mounted again. A line taken off the
 * page reports a size of nothing, and is let go of; one hidden while a hint takes its row keeps the last width.
 */
const resized = new ResizeObserver((entries) => {
  for (const e of entries) {
    if (!e.target.isConnected) {
      forget(e.target);
      continue;
    }
    const width = e.contentRect.width;
    if (!width || width === room.width) continue;
    room = { width, font: fontOf(e.target) };
    paint(/** @type {HTMLElement} */ (e.target));
  }
});

/**
 * Each line’s button, which opens its details (#1496): a chevron at the line’s end, so a touch screen shows there’s more,
 * kept across paints so focus stays on it. A click on a bar opens them too, and leaves its title to the pointer.
 */
const opens = new WeakMap();
/** The width the button takes from the bars: its 16 px and the 4 px left of the gap before it (workbench.css). */
const OPEN_W = 20;

/**
 * The conversation’s quota line, which paints itself as reports and the room change. A click on it, or Enter, opens
 * each backend’s details. @param {string} threadId @param {() => void} openDetails
 */
export function quotaLine(threadId, openDetails) {
  const el = h('div.quota-line', { role: 'group', 'aria-label': 'Quota by backend', dataset: { quotaLine: threadId } });
  opens.set(
    el,
    h('button.quota-open', { type: 'button', 'aria-label': 'Quota details', title: 'Each backend’s quota, in Settings', onclick: openDetails }, icon('right')),
  );
  el.addEventListener('click', (e) => {
    if (/** @type {Element} */ (e.target).closest('.quota-bar')) openDetails();
  });
  paint(el);
  lines.add(el);
  resized.observe(el);
  observed.add(el);
  onChangeWhileAlive(el, (live, change) => REPAINT_ON.has(change.type) && paint(live));
  return el;
}

// Ages and resets move with the clock, not with events: each minute, every line on the page says what’s true now.
setInterval(() => {
  for (const el of lines) if (el.isConnected) paint(el);
}, 60_000);
