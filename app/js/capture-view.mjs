// view_app’s capture mode (#95; designs/architecture.md, “Agents see their app”): the page Postbox’s own headless
// browser opens with ?capture=<item id>&thread=<thread id>. It shows that one app, as the conversation shows it,
// inline in the conversation’s column, and nothing else: no stream, no composer, no report that a thread is open.
// It marks itself ready once the app’s frame has loaded and sized, and missing when there’s no such app.

import { renderAppItem } from './apps.mjs';
import { client, itemIn } from './client.mjs';
import { h } from './dom.mjs';

const params = new URLSearchParams(location.search);
/** The item to capture, or null on every ordinary page load. */
export const CAPTURE = params.get('capture');
/** How long the app may take to load and size before the page says it’s ready anyway: view_app has its own limit. */
const SETTLE_MS = 12000;

/** @param {HTMLElement} root */
export function mountCapture(root) {
  const threadId = params.get('thread') ?? '';
  const item = CAPTURE ? itemIn(threadId, CAPTURE) : null;
  if (!item?.block || !client.state.apps?.[item.block.id]) {
    root.replaceChildren(h('p', { dataset: { capture: 'missing' } }, 'There’s no such app here.'));
    return;
  }
  // The app as it is, whatever its check says: the agent asked to see it, and its check may still be pending. This page
  // has its own copy of the state, with no stream, so this changes nothing for the person.
  const app = client.state.apps[item.block.id];
  app.check = { ...(app.check ?? {}), status: 'passed' };
  const holder = h('div.item', { dataset: { key: item.id, captureItem: '' } });
  const paint = () => holder.replaceChildren(renderAppItem(item, { threadId, rerender: paint }));
  paint();
  root.replaceChildren(h('main.transcript', h('div.col', holder)));
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
