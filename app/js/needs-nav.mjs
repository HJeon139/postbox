// Going to what an agent needs (#285). Its pulsing ring, wherever it shows (the rail, the Agents section, the overview,
// beside its messages, the top bar), and its rail row and Agents row while it needs you, all go to its ask: the same
// way ⌃J and the top bar’s “Next that needs you” do. Each opens the ask’s thread (the side panel for a side or topic
// thread), waits for it to be drawn, then scrolls it into view, focuses it, and outlines it for a moment.

import { conversationOf, needsOrder, needsYouNow, whereNeeds } from '/shared/needs.mjs';
import { client, hrefOf, liveSessions } from './client.mjs';
import { h, icon } from './dom.mjs';
import { navigate, route, toast } from './ui.mjs';

const S = () => client.state;
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

/** Where the page is: the thread on screen (the side panel’s when it’s open) and its conversation. */
function here() {
  const r = route();
  if (r.view !== 'thread') return { at: null, conv: null };
  return { at: r.sideId ?? r.threadId, conv: conversationOf(S(), r.threadId) };
}

/**
 * Scrolls an item into view, focuses what can be answered in it, and outlines it for a moment. It waits for the item
 * to be drawn, and for its transcript to settle at its end first, so the transcript doesn’t pull it back off screen.
 * @param {string} itemId
 */
export async function focusItem(itemId) {
  const find = () => document.querySelector(`[data-key="${CSS.escape(itemId ?? '')}"]`);
  let node = find();
  for (const end = Date.now() + 3000; !node && Date.now() < end; node = find()) await frame();
  if (!node) return false;
  // A transcript just mounted settles at its end on its first frame (thread.mjs, settle()).
  await frame();
  await frame();
  node = find() ?? node;
  node.scrollIntoView({ block: 'center' });
  const control = node.querySelector('button:not([disabled]), input, textarea, select');
  if (!control && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  (control ?? node).focus({ preventScroll: true });
  node.classList.remove('arrived');
  void node.offsetWidth;
  node.classList.add('arrived');
  setTimeout(() => node.classList.remove('arrived'), 1600);
  return true;
}

let last = null;
/** Goes to what an agent needs: its ask’s thread, then the ask itself. */
export function goToNeeds(se) {
  if (!needsYouNow(se)) return;
  const where = whereNeeds(S(), se);
  last = { sessionId: se.id, where };
  if (here().at !== where) navigate(hrefOf(where));
  focusItem(se.needs.itemId);
}

/**
 * ⌃J: the open conversation’s agent that needs you first, else the one that has waited longest. Pressed again where it
 * took you, it moves on to the next one, oldest first, so every agent that needs you comes up in turn.
 */
export function nextNeedsYou() {
  const at = here();
  const all = needsOrder(S(), liveSessions());
  if (!all.length) {
    toast({ title: 'Nothing needs you right now' });
    return;
  }
  const i = last && last.where === at.at ? all.findIndex((se) => se.id === last.sessionId) : -1;
  goToNeeds(i >= 0 ? all[(i + 1) % all.length] : needsOrder(S(), all, at.conv)[0]);
}

/** The agents of a conversation that need you, the one that has waited longest first: its side and topic threads’ too. */
const needingIn = (threadId) => needsOrder(S(), liveSessions()).filter((se) => conversationOf(S(), whereNeeds(S(), se)) === threadId);

// One listener for every ring and row, ahead of their own: a ring in a link or a button goes to the ask instead.
document.addEventListener(
  'click',
  (e) => {
    const el = /** @type {Element} */ (e.target);
    const ring = el.closest?.('pb-ring[data-session]');
    const button = el.closest?.('.agent-btn[id^="agent-row-"], .ring-btn[id^="top-ring-"]');
    const row = el.closest?.('.rail a.row[data-thread], .ringstrip a[href^="#/t/"]');
    let se = ring ? S().sessions[/** @type {HTMLElement} */ (ring).dataset.session ?? ''] : null;
    if (!needsYouNow(se) && button) se = S().sessions[button.id.replace(/^(agent-row|top-ring)-/, '')];
    if (!needsYouNow(se) && row) se = needingIn(/** @type {HTMLElement} */ (row).dataset.thread ?? row.getAttribute('href')?.slice(4) ?? '')[0];
    if (!needsYouNow(se)) return;
    e.preventDefault();
    e.stopPropagation();
    goToNeeds(se);
  },
  true,
);
// A ring that isn’t in a link or a button is a button of its own while its agent needs you (ring.mjs).
document.addEventListener('keydown', (e) => {
  const ring = /** @type {HTMLElement} */ (e.target).closest?.('pb-ring[role=button][data-session]');
  if (!ring || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  goToNeeds(S().sessions[/** @type {HTMLElement} */ (ring).dataset.session ?? '']);
});

/**
 * The quick panel’s button under an agent’s row in the Agents section, shown while the row goes to its ask instead:
 * Stop, Permissions and the persona stay a click away.
 * @param {any} se  @param {HTMLElement} row  the row’s own button  @param {(sessionId: string, from: HTMLElement) => void} open  opens the panel
 */
export function panelWhileNeeds(se, row, open) {
  const el = h(
    'button.btn.icon.sm.ghost',
    { type: 'button', dataset: { needsMore: se.id }, 'aria-label': `More for @${se.handle}`, 'aria-haspopup': 'dialog', onclick: () => open(se.id, el) },
    icon('more'),
  );
  paint(el, se.id);
  paint(row, se.id);
  return el;
}
/** The ⋯ shows while its agent needs you; a row or top-bar ring opens a dialog only while it doesn’t. */
function paint(el, sessionId) {
  const needs = needsYouNow(S().sessions[sessionId]);
  if (el.dataset.needsMore) el.hidden = !needs;
  else if (needs) el.removeAttribute('aria-haspopup');
  else el.setAttribute('aria-haspopup', 'dialog');
}
client.on((ch) => {
  if (ch.type !== 'session' && ch.type !== 'load') return;
  for (const el of document.querySelectorAll('[data-needs-more]'))
    paint(/** @type {HTMLElement} */ (el), /** @type {HTMLElement} */ (el).dataset.needsMore ?? '');
  for (const el of document.querySelectorAll('.agent-btn[id^="agent-row-"], .ring-btn[id^="top-ring-"]'))
    paint(/** @type {HTMLElement} */ (el), el.id.replace(/^(agent-row|top-ring)-/, ''));
});
