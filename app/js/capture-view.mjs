// view_app’s capture mode (#95; designs/architecture.md, “Agents see their app”): the page Postbox’s own headless
// browser opens with ?capture=<item id>&thread=<thread id>. It shows that one app, as the conversation shows it,
// inline and as wide as the conversation (thread.mjs), and nothing else: no stream, no composer, no report that a
// thread is open.
// The conversation is as wide as the person’s tab reported (&column=<px>), beside their rail and any open pane; with
// no report, it sits beside the rail in the page’s own shell, as a person opening Postbox at that size would see it.
// It marks itself ready once the app’s frame has loaded and sized, and missing when there’s no such app. The page’s
// state holds no conversation’s items (#1155), so it asks the server for the app’s item first.

import { renderAppItem } from './apps.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { fetchRange } from './item-ranges.mjs';

const params = new URLSearchParams(location.search);
/** The item to capture, or null on every ordinary page load. */
export const CAPTURE = params.get('capture');
/** How long the app may take to load and size before the page says it’s ready anyway: view_app has its own limit. */
const SETTLE_MS = 12000;

/** The item to capture, from the server, or null when there’s no such item. @param {string} threadId @param {string} id */
async function captured(threadId, id) {
  const range = await fetchRange(threadId, `?around=${encodeURIComponent(id)}&limit=1`).catch(() => null);
  return range?.items.find((it) => it.id === id) ?? null;
}

/** @param {HTMLElement} root */
export async function mountCapture(root) {
  const threadId = params.get('thread') ?? '';
  const item = CAPTURE ? await captured(threadId, CAPTURE) : null;
  if (!item?.block || !client.state.apps?.[item.block.id]) {
    root.replaceChildren(h('p', { dataset: { capture: 'missing' } }, 'There’s no such app here.'));
    return;
  }
  // The app itself while its check is pending or its agent is fixing what the check found: the agent asked to see it,
  // and the person would see a placeholder. Any other result, a note say, shows as the person sees it. This page has
  // its own copy of the state, with no stream, so this changes nothing for the person.
  const app = client.state.apps[item.block.id];
  if (app.check?.status === 'pending' || app.check?.status === 'fixing') app.check = { ...app.check, status: 'passed' };
  // As thread.mjs wraps an app in the transcript: wider than the text column, as wide as the conversation.
  const holder = h('div.wide.item', { dataset: { key: item.id, captureItem: '' } });
  const paint = () => holder.replaceChildren(renderAppItem(item, { threadId, rerender: paint }));
  paint();
  const transcript = h('div.transcript', holder);
  const column = Number(params.get('column'));
  root.replaceChildren(
    column > 0
      ? h('div.main', { style: { width: `${column}px` } }, transcript)
      : // An empty rail takes the rail’s room, so the shell’s own grid sets the conversation’s width.
        h('div.app', h('nav.rail', { 'aria-hidden': 'true' }), h('div.main', transcript)),
  );
  const started = Date.now();
  const settle = () => {
    const frame = holder.querySelector('iframe.app-iframe');
    if (frame instanceof HTMLElement && frame.dataset.sized) {
      // One more frame, so what sized it has painted.
      requestAnimationFrame(() => {
        root.dataset.capture = 'ready';
      });
      return;
    }
    if (Date.now() - started > SETTLE_MS) {
      root.dataset.capture = 'ready';
      return;
    }
    setTimeout(settle, 100);
  };
  settle();
}
