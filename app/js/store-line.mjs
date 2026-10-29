// The store’s status line (#508’s requirements, ST-3; design 6.6, decision 7). While the server can’t save changes,
// one line at the bottom of the window says why, in plain words, with Retry. The page stays readable: nothing covers
// it, and the composer moves up above the line. A write made meanwhile is refused with the same cause, which the
// place that made it shows as any refused write. The line goes once the server can save again.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { say } from './ui.mjs';

/** What each cause means for you, first: the server’s message after it says what happened and what to do. */
const LEAD = {
  'port-taken': 'Postbox can’t save changes: another program has its store’s port.',
  'binary-missing': 'Postbox can’t save changes: its store’s Redis is missing.',
  'corrupt-aof': 'Postbox can’t save changes: its store’s file is damaged.',
  died: 'Postbox can’t save changes: its store stopped, and Postbox is starting it again.',
  'write-failed': 'Postbox can’t save changes: its store refused a write.',
  reconciling: 'Postbox can’t save changes yet: it’s reading back what its store holds.',
};

const line = h('div.store-line', { role: 'status', hidden: true });
document.body.append(line);
let wasDown = false;
let retrying = false;

function paint() {
  const st = client.store;
  const down = st?.state === 'down';
  document.documentElement.classList.toggle('store-down', down);
  line.hidden = !down;
  if (!down) {
    line.replaceChildren();
    if (wasDown) say('Postbox can save changes again.');
    wasDown = false;
    return;
  }
  wasDown = true;
  const retry = h('button.btn.sm', { type: 'button', disabled: retrying, onclick: () => retryNow(retry) }, retrying ? 'Retrying…' : 'Retry');
  line.replaceChildren(
    h(
      'p.store-text',
      h('strong', LEAD[st.cause] ?? 'Postbox can’t save changes right now.'),
      ' ',
      h('span.dim', `${st.message ?? ''} Agents don’t start new turns until then; you can still read everything.`),
    ),
    retry,
  );
}

/** Asks the server to start its store again, or read it back now. @param {HTMLButtonElement} button */
async function retryNow(button) {
  retrying = true;
  button.disabled = true;
  button.textContent = 'Retrying…';
  try {
    // What it leads to comes over the live stream, in order; the reply’s status may already be older than that.
    await api('/api/store/retry', {});
  } catch (e) {
    say(`Retry didn’t go through: ${e.message}`);
  } finally {
    retrying = false;
    paint();
  }
}

client.on((ch) => {
  if (ch.type === 'load' || ch.type === 'store') paint();
});
