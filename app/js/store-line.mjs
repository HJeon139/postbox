// The store’s status line (#508’s requirements, ST-3; design 6.6, decision 7). While the server can’t save changes,
// one line at the bottom of the window says why, in plain words, with Retry. The page stays readable: nothing covers
// it, and the composer moves up above the line. A write made meanwhile is refused with the same cause, which the
// place that made it shows as any refused write. The line goes once the server can save again.

import { api, client } from './client.mjs';
import { h } from './dom.mjs';
import { say, toast } from './ui.mjs';

/** What each cause means for you, first: the server’s message after it says what happened and what to do. */
const LEAD = {
  socket: 'Postbox can’t save changes: its store couldn’t open its private socket.',
  owned: 'Postbox can’t save changes: another store is already running on its data folder.',
  'binary-missing': 'Postbox can’t save changes: its store’s Redis is missing.',
  'corrupt-aof': 'Postbox can’t save changes: its store’s file is damaged.',
  died: 'Postbox can’t save changes: its store stopped, and Postbox is starting it again.',
  'write-failed': 'Postbox can’t save changes: its store refused a write.',
  rejected: 'Postbox can’t save changes: its store refused one for good, so what you see isn’t all saved.',
  reconciling: 'Postbox can’t save changes yet: it’s reading back what its store holds.',
  starting: 'Postbox can’t save changes yet: it’s starting its store.',
  stopped: 'Postbox can’t save changes: it stopped its store.',
};

const line = h('div.store-line', { role: 'status', hidden: true });
document.body.append(line);
let wasDown = false;
let retrying = false;
let toldDropped = 0; // the `at` of the last dropped write the page has told of

/**
 * Changes the store’s Redis refused for good were dropped by Retry (server/store-reject.mjs): the page has loaded what’s
 * saved, the store runs on, so the line stays hidden, and a notice says which changes weren’t saved.
 */
function noteDropped(st) {
  const d = st?.dropped;
  if (!d || d.at === toldDropped) return;
  toldDropped = d.at;
  const range = d.from === d.to ? `change ${d.from}` : `changes ${d.from}–${d.to}`;
  toast({
    title: `Postbox couldn’t save ${d.events === 1 ? 'one change' : `${d.events} changes`}`,
    text: `Its store refused ${range} for a reason a retry can’t change: ${d.message} The page now shows what’s saved, without ${d.events === 1 ? 'it' : 'them'}${d.changes?.length ? ` (${d.changes.join('; ')})` : ''}.`,
    level: 'blocking',
    timeout: 0,
  });
}

/** Shows the line exactly while the store is down: the server says down, with a cause, whenever it can’t save. */
function paint() {
  const st = client.store;
  noteDropped(st);
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
