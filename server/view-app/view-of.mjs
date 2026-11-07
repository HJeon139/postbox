// Each running Postbox’s view_app state (server/view-app/view-app.mjs’s ViewApp), kept beside its Runtime, which is
// at its length ceiling. A module of its own, so view-app.mjs and consent.mjs can both reach it without importing each
// other.

/** @type {WeakMap<object, import('./view-app.mjs').ViewApp>} */
const views = new WeakMap();

/** Gives a Runtime its ViewApp (server/index.mjs). @param {object} rt @param {import('./view-app.mjs').ViewApp} view */
export function attachViewApp(rt, view) {
  views.set(rt, view);
  return view;
}

/** The Runtime’s ViewApp. @param {object} rt */
export function viewOf(rt) {
  const v = views.get(rt);
  if (!v) throw new Error('view_app isn’t set up in this Postbox.');
  return v;
}
