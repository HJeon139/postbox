// Your queue (#558, prototype): the messages that @-mention you, an agent’s or another person’s, each to open or
// dismiss. It is your seat’s inbox, as an agent’s queue is its own, and what’s waiting in it needs you and no one else.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { initials } from './profile-tab.mjs';
import { navigate, openMenu } from './ui.mjs';

const waiting = () => client.who?.queue ?? [];
const words = (/** @type {number} */ n) => (n === 1 ? '1 message for you' : `${n} messages for you`);

async function settle(/** @type {any} */ e, /** @type {'read' | 'dismissed'} */ state) {
  await api(`/api/me/queue/${e.id}`, { state });
  await refresh();
}

function open(/** @type {HTMLElement} */ button) {
  const items = waiting().flatMap((/** @type {any} */ e) => {
    const where = client.state.threads[e.threadId]?.title ?? 'a conversation';
    return [
      { heading: `${e.from} in ${where}` },
      { label: 'Open it', run: () => settle(e, 'read').then(() => navigate(`#/t/${e.threadId}`)) },
      { label: 'Dismiss', run: () => settle(e, 'dismissed') },
    ];
  });
  openMenu(button, items, { label: 'Your queue' });
}

/** The top bar’s button: hidden while nothing waits for you. */
function queueButton() {
  const n = waiting().length;
  return h(
    'button.btn.sm',
    { type: 'button', id: 'your-queue', hidden: !n, onclick: (/** @type {Event} */ ev) => open(/** @type {HTMLElement} */ (ev.currentTarget)) },
    h('span.g.g-needs', { 'aria-hidden': 'true' }),
    h('span', words(n)),
  );
}

async function refresh() {
  const r = await fetch('/api/me');
  if (!r.ok) return;
  client.who = await r.json();
  const button = document.getElementById('your-queue');
  if (!button) return;
  const n = waiting().length;
  button.hidden = !n;
  if (button.lastElementChild) button.lastElementChild.textContent = words(n);
}

// A message that names you arrives as its item’s `forPeople`; your own send may have answered what waited.
client.on((/** @type {any} */ ch) => {
  if (!ch.type?.startsWith('item.')) return;
  const item = ch.data?.item ?? ch.data?.patch ?? {};
  const me = client.who?.me?.id;
  if (item.forPeople?.some((/** @type {any} */ p) => p.id === me) || (item.kind === 'user' && waiting().length)) refresh().catch(() => {}); // offline: the next change asks again
});

/**
 * The top bar’s controls for the one looking: their queue, and their initials, which open the main menu at their
 * profile. The button’s name stays “Settings”: it is the way into all of it. @param {(tab: string) => void} openSettings
 */
export const meControls = (openSettings) => [
  queueButton(),
  h(
    'button.btn.icon.sm.ghost',
    { type: 'button', 'aria-label': 'Settings', title: client.who?.me?.name, onclick: () => openSettings('profile') },
    h('span.me-icon', { id: 'me-icon', 'aria-hidden': 'true', 'data-initials': initials() }),
  ),
];
