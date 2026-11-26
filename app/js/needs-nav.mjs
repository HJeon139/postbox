// Going to what an agent needs (#285). Its pulsing ring, wherever it shows (a rail row, the Agents section, beside its
// messages), goes to its ask, the same way ⌃J and the top bar’s “Next that needs you” do. Only the ring does (#320):
// a rail row opens its conversation and an agent’s name its persona sheet, whether it needs you or not. Each opens the ask’s thread (the side panel for a side or topic
// thread), waits for it to be drawn, then scrolls it into view, focuses it, and outlines it for a moment.

import { conversationOf, needsOrder, whereNeeds } from '/shared/needs.mjs';
import { client, itemIn, liveSessions } from './client.mjs';
import { itemHref } from './item-address.mjs';
import { meId, needsMe } from './needs-mine.mjs';
import { reach } from './open-threads.mjs';
import { navigate, paneHref, route, toast } from './ui.mjs';
import { jumpTo } from './view-jump.mjs';
import { mountFor } from './window-live.mjs';

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
 * An item the page hasn’t loaded is loaded first, with the range around it, in its conversation or the one on screen
 * (#1155).
 * @param {string} itemId @param {string | null} [threadId]
 */
export async function focusItem(itemId, threadId = null) {
  // With no conversation named, the one on screen: an item the page doesn’t hold elsewhere is in no view to jump in.
  const r = route();
  await reach(threadId ?? (r.view === 'thread' ? r.threadId : null), itemId);
  // A window holding the item off the page mounts it first (window.mjs, #866).
  const find = () => mountFor(itemId ?? '') ?? document.querySelector(`[data-key="${CSS.escape(itemId ?? '')}"]`);
  let node = find();
  for (const end = Date.now() + 3000; !node && Date.now() < end; node = find()) await frame();
  if (!node) return false;
  // A transcript just mounted settles at its end on its first frame (thread.mjs, settle()).
  await frame();
  await frame();
  node = find() ?? node;
  jumpTo(node);
  // Tell its transcript now, as its scroll event would a frame later: what grows in between (an app’s check giving way to
  // its frame) would read as the view having stopped short of the end, and be held there, the item under the composer (#410).
  const scroller = node.parentElement?.parentElement;
  (scroller?.matches('.sp-body') ? scroller : window).dispatchEvent(new Event('scroll'));
  const control = node.querySelector('button:not([disabled]), input, textarea, select');
  if (!control && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  (control ?? node).focus({ preventScroll: true });
  node.classList.remove('arrived');
  void node.offsetWidth;
  node.classList.add('arrived');
  setTimeout(() => node.classList.remove('arrived'), 1600);
  return true;
}

/**
 * Goes to an item in a thread: opens the thread when it isn’t the one on screen (the side panel for a side or topic
 * thread), then the item, as goToNeeds does for a need (#543).
 * @param {string} itemId @param {string} threadId
 */
export function goToItem(itemId, threadId) {
  if (!threadId) return focusItem(itemId, null);
  return goToAddress(itemId, threadId);
}

/** @type {{ conv: string, key: string } | null} the message last gone to by its address, in its conversation */
let addressed = null;

/**
 * Goes to a message by its address (#168): the address goes on the history, so Back returns, and this goes to the
 * message itself, every time it’s asked, a second time after a pane change too. In the conversation on screen, Work
 * stays, with its turn and the item open in it, and a full view only when it’s the message’s own thread.
 * @param {string} itemId @param {string} threadId
 */
function goToAddress(itemId, threadId) {
  const r = route();
  const conv = conversationOf(S(), threadId);
  const side = threadId === conv ? null : threadId;
  // A full view stays only if it’s this thread’s: full-screen Work, or another thread, would cover the message.
  const full = r.full === 'thread' && r.sideId === side ? r.full : null;
  // An item open in Work beside the thread stays; one open in full-screen Work goes with it.
  const pane = { work: r.work, turn: r.turn, full, at: r.full === 'work' ? null : r.at };
  const to = r.view === 'thread' && r.threadId === conv ? paneHref(conv, { ...pane, side, item: itemId }) : itemHref(threadId, itemId);
  // The address is this one’s: focusAddressed, as it comes in, doesn’t go to it a second time.
  addressed = { conv, key: `${threadId}?m=${itemId}` };
  navigate(to);
  return landOn(itemId, threadId);
}

/**
 * Goes to a message, and says so when the thread doesn’t have it. One loaded but not drawn in time is a slow page, not
 * a missing message. @param {string} itemId @param {string} threadId
 */
async function landOn(itemId, threadId) {
  const found = await focusItem(itemId, threadId);
  if (!found && !itemIn(threadId, itemId)) toast({ title: 'That message isn’t here', text: 'It may have been deleted, or it’s in another conversation.' });
  return found;
}

/**
 * Goes to the message an address the page didn’t make names (m=, #168): as the page loads, and as Back, forward or a
 * pasted address changes it, once per message in a conversation, so Back to an address within it, as after a link to
 * Work, doesn’t pull the view back to the message. Going to it on purpose is goToAddress’s. One the thread doesn’t
 * have opens the thread and says so.
 */
export function focusAddressed() {
  const r = route();
  if (r.view !== 'thread' || addressed?.conv !== r.threadId) addressed = null;
  if (r.view !== 'thread' || !r.item) return;
  const thread = r.sideId ?? r.threadId;
  const key = `${thread}?m=${r.item}`;
  if (addressed?.key === key) return;
  addressed = { conv: r.threadId, key };
  void landOn(r.item, thread);
}

let last = null;
/** Goes to what an agent needs: its ask’s thread, then the ask itself. */
export function goToNeeds(se) {
  if (!needsMe(se)) return;
  const where = whereNeeds(S(), se);
  last = { sessionId: se.id, where };
  void goToAddress(se.needs.itemId, where);
}

/**
 * ⌃J: the open conversation’s agent that needs you first, else the one that has waited longest. Pressed again where it
 * took you, it moves on to the next one, oldest first, so every agent that needs you comes up in turn.
 */
export function nextNeedsYou() {
  const at = here();
  const all = needsOrder(S(), liveSessions(), null, meId());
  if (!all.length) {
    toast({ title: 'Nothing needs you right now' });
    return;
  }
  const i = last && last.where === at.at ? all.findIndex((se) => se.id === last.sessionId) : -1;
  goToNeeds(i >= 0 ? all[(i + 1) % all.length] : needsOrder(S(), all, at.conv, meId())[0]);
}

// One listener for every ring, ahead of what it’s in: a ring in a rail row’s link goes to the ask instead of the
// conversation. A click with a modifier key is left to the browser, so ⌘- or ⌃-click still opens the row in a new tab.
document.addEventListener(
  'click',
  (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const ring = /** @type {Element} */ (e.target).closest?.('pb-ring[data-session]:not([state="rest"])');
    const se = ring ? S().sessions[/** @type {HTMLElement} */ (ring).dataset.session ?? ''] : null;
    if (!needsMe(se)) return;
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
