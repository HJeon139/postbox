// A transcript view’s state as it starts (view-state.mjs’s mountView). Moved from view-state.mjs, unchanged, to keep
// that file under its length limit.

/** @typedef {import('./view-state.mjs').View} View */

/**
 * A view’s state as it starts: following, unless it comes back from a rebuild while reading (was). Its observers are
 * added by mountView.
 * @param {{ el: HTMLElement, inPanel: boolean, nodes: Map<string, HTMLElement>, was?: { anchor: any, unseen: number } }} o
 * @returns {View}
 */
export function newView({ el, inPanel, nodes, was }) {
  return /** @type {any} */ ({
    el,
    inPanel,
    nodes,
    unseen: was?.unseen ?? 0,
    stuck: !was,
    anchor: was?.anchor ?? null,
    pinned: false,
    smoothing: false,
    dead: false,
    shown: -1,
    lastTop: 0,
    held: { end: 0, last: 0, width: 0 },
    jump: null,
    bound: null,
    size: '',
  });
}
