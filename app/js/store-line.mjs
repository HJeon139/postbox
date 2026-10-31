// The store’s status line (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I2). While the server
// can’t save changes, one line at the bottom of the window says what happened and what to do, with Retry. The page stays
// readable: nothing covers it, and the composer moves up above the line. What agents said after the failure is shown but
// not saved, and the line says how many changes that is, from the last durable seq the server reports (savedThrough);
// they disappear at Retry or a restart. A write made meanwhile is refused with the same cause, which the place that made
// it shows as any refused write. The line goes once the server can save again. A failed snapshot shows as a warning that
// closes nothing.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { say } from './ui.mjs';

/** What each cause means for you, first: the server’s message after it says what happened and what to do. */
const LEAD = {
  ENOSPC: 'Postbox can’t save changes: the disk is full.',
  EROFS: 'Postbox can’t save changes: its data folder is read-only.',
  EIO: 'Postbox can’t save changes: the disk reported an error.',
  EACCES: 'Postbox can’t save changes: it isn’t allowed to write its data folder.',
};

const line = h('div.store-line', { role: 'status', hidden: true });
document.body.append(line);
let wasDown = false;

/** Shows the line exactly while the store can’t be written, or carries a warning while it can. */
function paint() {
  const st = client.store;
  const down = st && !st.writable;
  document.documentElement.classList.toggle('store-down', !!down);
  if (!down) {
    line.hidden = !st?.warning;
    line.replaceChildren(...(st?.warning ? [h('p.store-text', h('span.dim', st.warning))] : []));
    if (wasDown) say('Postbox can save changes again.');
    wasDown = false;
    return;
  }
  wasDown = true;
  line.hidden = false;
  const unsaved = Math.max(0, client.seq - (st.savedThrough ?? client.seq));
  const retry = h('button.btn.sm', { type: 'button', disabled: st.retrying, onclick: () => retryNow() }, st.retrying ? 'Retrying…' : 'Retry');
  line.replaceChildren(
    h(
      'p.store-text',
      h('strong', LEAD[st.cause?.code] ?? 'Postbox can’t save changes right now.'),
      ' ',
      h(
        'span.dim',
        `${st.cause?.message ?? ''} Agents stopped and don’t start new turns until then; you can still read everything.${
          unsaved
            ? ` ${unsaved === 1 ? 'One change' : `${unsaved} changes`} shown here since then ${unsaved === 1 ? 'isn’t' : 'aren’t'} saved and will disappear when Postbox can save again.`
            : ''
        }`,
      ),
    ),
    retry,
  );
}

/** Asks the server to reload its store and reopen writes; what it leads to comes over the live stream as status frames. */
async function retryNow() {
  try {
    await api('/api/store/retry', {});
  } catch (e) {
    say(`Retry didn’t go through: ${e.message}`);
  }
}

client.on((ch) => {
  if (ch.type === 'load' || ch.type === 'store') paint();
});
