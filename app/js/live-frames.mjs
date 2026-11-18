// A running turn’s live frames on the page (designs/architecture/live-progress.md): the glue between the page’s client
// and shared/live-apply.mjs, which applies a frame through the page’s reducer. A frame arrives as a `live` change
// (client.mjs); the running turns’ snapshots arrive with the state at load; and a frame held for an item the page
// didn’t have applies once the item is added or its range loads. Each applied frame is told to the page as the change
// it stands for, so whatever draws a step or a session draws it as before.

import { liveApplier } from '/shared/live-apply.mjs';
import { client, itemIn, resync } from './client.mjs';

const live = liveApplier();
const has = (/** @type {string} */ threadId, /** @type {string} */ id) => Boolean(itemIn(threadId, id));
const tell = (/** @type {any[]} */ changes) => {
  for (const c of changes) client.emit(c);
};

client.on((ch) => {
  if (ch.type === 'live') {
    // A page ahead of its stream, as after it loads a conversation’s range while the stream runs late, may have stored
    // what a step or session frame says, newer, so it drops them, as it drops a header then. A text frame adds only the
    // words the page lacks, so it applies: its commit point isn’t sent to a page that was sent it (server/live-sent.mjs).
    if (ch.behind && ch.data?.kind !== 'text') return;
    tell(live.apply(client.state, ch.data, has));
    // A dropped frame’s step may never be sent again (server/live-sent.mjs): the state, with its snapshot, has it.
    if (live.lost()) void resync();
  } else if (ch.type === 'load') tell(live.snapshot(client.state, client.live, has));
  // A held frame applies once its item is there, and a text frame once the words before it are.
  else if (ch.type === 'item.add' || ch.type === 'range' || ch.type === 'item.text') tell(live.flush(client.state, has));
});
