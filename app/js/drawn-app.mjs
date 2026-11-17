// The app an item’s node draws, and what of that app the node was drawn from, so the transcript can tell when a
// change to the app means drawing the item again.

/** What of an app its item’s node shows: its version, its check, and whether it’s retired. @param {any} app */
export const appSig = (app) =>
  JSON.stringify([app.current, app.versions?.length, app.check?.status, app.check?.problems?.length ?? 0, app.retired?.at ?? null]);

/** The id of the app a block draws: an app’s own, or an app review’s (#857). @param {any} it */
export const drawnApp = (it) => {
  if (it.kind !== 'block' || !it.valid) return null;
  if (it.block.type === 'app') return it.block.id;
  if (it.block.type === 'review' && it.block.format === 'app') return it.block.appId;
  return null;
};
