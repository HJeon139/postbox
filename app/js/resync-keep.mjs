// What a transcript keeps when it’s built again from a new state, as on a resync or a range landing (#987). Built
// from nothing, every item node was new, so every app’s frame loaded again and lost what it held: a half-filled form,
// a scroll position, a running simulation. Now an item that hasn’t changed keeps its node, where it is on the page:
// taken out of the page and put back, a frame loads again, so a kept node never moves, and what’s new is put around it.
//
// Unchanged means its record is the same, the item before it is the same one (its speaker line reads that), and its
// app and its look on a host are as it drew them. Only mounted items are compared, which the window bounds (#866),
// so a resync’s cost follows what’s on the page, not the length of the room.

import { S } from './client.mjs';
import { appSig, drawnApp } from './drawn-app.mjs';
import { remoteSig } from './thread-host.mjs';
import { replaced } from './window-shrink.mjs';

/** Each item node, and the item and the item before it that it was drawn from. @type {WeakMap<Element, { it: any, prevId: string | null }>} */
const drawnFrom = new WeakMap();
/** The stand-ins a build mounts for the nodes it keeps. @type {WeakSet<Element>} */
const standIns = new WeakSet();

/** Notes what an item’s node was drawn from. @param {HTMLElement} node @param {any} it @param {any} prev */
export function noteDrawn(node, it, prev) {
  drawnFrom.set(node, { it, prevId: prev?.id ?? null });
}

/**
 * The item nodes on the page the new list leaves as they are, by id, in the page’s order. A node whose item moved
 * ahead of one kept before it is drawn again, since keeping both would move one.
 * @param {HTMLElement} el  the transcript @param {Map<string, HTMLElement>} nodes  its item nodes
 * @param {any[]} list  the new items @param {(id: string) => number} at  an item’s place in it
 * @param {string | undefined} skip  the item with focus, which the window puts back itself (window-keep.mjs)
 */
export function keepable(el, nodes, list, at, skip) {
  /** @type {Map<string, HTMLElement>} */
  const keep = new Map();
  let last = -1;
  for (const node of /** @type {HTMLCollectionOf<HTMLElement>} */ (el.children)) {
    const id = node.dataset.key;
    const was = drawnFrom.get(node);
    if (!id || id === skip || !was || nodes.get(id) !== node) continue;
    const i = at(id);
    if (i <= last || (list[i - 1]?.id ?? null) !== was.prevId || !drawnSame(node, was.it, list[i])) continue;
    keep.set(id, node);
    last = i;
  }
  return keep;
}

/** Whether the node drew this item as it is now: its record, its app and its look on a host. */
function drawnSame(/** @type {HTMLElement} */ node, /** @type {any} */ was, /** @type {any} */ it) {
  if (JSON.stringify(was) !== JSON.stringify(it)) return false;
  const app = S().apps[drawnApp(it)];
  if ((node.dataset.appSig ?? null) !== (app ? appSig(app) : null)) return false;
  return it.kind !== 'agent' || node.dataset.remoteSig === remoteSig(it);
}

/** Empties the transcript but for the nodes it keeps, which stay where they are. @param {HTMLElement} el @param {Map<string, HTMLElement>} keep */
export function clearBut(el, keep) {
  const kept = new Set(keep.values());
  for (const n of [...el.childNodes]) if (!kept.has(/** @type {HTMLElement} */ (n))) n.remove();
}

/** What a build mounts in place of a kept node, for adopt to put the node in. @param {string} id */
export function standIn(id) {
  const node = document.createElement('div');
  node.className = 'item';
  node.dataset.key = id;
  standIns.add(node);
  return node;
}

/**
 * After a build: each kept node takes its stand-in’s place without moving, since what’s around it moves instead. A
 * kept node the build didn’t mount goes. A window measures and counts the node in its place, as it did the stand-in.
 * @param {HTMLElement} el @param {Map<string, HTMLElement>} keep @param {Map<string, HTMLElement>} nodes
 * @param {any} win  the transcript’s window, or null
 */
export function adopt(el, keep, nodes, win) {
  /** @type {Map<Node, HTMLElement>} */
  const placed = new Map();
  for (const [id, node] of keep) {
    const stand = nodes.get(id);
    if (!stand || !standIns.has(stand) || !stand.isConnected) {
      node.remove();
      continue;
    }
    placed.set(stand, node);
    nodes.set(id, node);
    if (win) {
      replaced(win, stand, node);
      win.counted(win.indexOf.get(id), node);
    }
  }
  const kept = new Set(placed.values());
  // The order the build made, with each kept node for its stand-in. The kept nodes are first on the page, in this
  // order, so going down it, each node not yet in its place goes in before the next kept one, which never moves.
  const want = [...el.childNodes].filter((n) => !kept.has(/** @type {HTMLElement} */ (n))).map((n) => placed.get(n) ?? n);
  let at = el.firstChild;
  for (const n of want) {
    if (n === at) at = at.nextSibling;
    else el.insertBefore(n, at);
  }
  for (const stand of placed.keys()) /** @type {ChildNode} */ (stand).remove();
}
