// What the person has typed or picked in an open block and not yet sent: its draft, kept by the block's item id, so a
// redraw (a revision, a resync) keeps it. Split out of app/js/blocks.mjs.

export const drafts = new Map(); // item id → local, unsent input
export const draft = (id, init) => {
  if (!drafts.has(id)) drafts.set(id, init());
  return drafts.get(id);
};
