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
    tell(live.apply(client.state, ch.data, has));
    // A dropped frame’s step may never be sent again (server/live-sent.mjs): the state, with its snapshot, has it.
    if (live.lost()) void resync();
  } else if (ch.type === 'load') tell(live.snapshot(client.state, client.live, has));
  else if (ch.type === 'item.add' || ch.type === 'range') tell(live.flush(client.state, has));
});
