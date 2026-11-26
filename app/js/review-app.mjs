// An app in a review: the app in review mode, where its registered anchors carry name tags, and the comments on each
// anchor beside it (designs/agent-apps.md, the review block). An app that names no parts says so, and the person
// comments on the whole app instead (#855).

import { mountApp } from './apps.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';

/** The anchor of a comment on the app as a whole: what the agent reads in the answer. */
export const WHOLE_APP = 'the whole app';

/** The review being rebuilt around its live app (rerenderAround): its item, and which app and mode that app shows. */
let keeping = null;
/** An item’s block on the page, when a rerender kept the one that was there: a newer render’s handlers find it here. */
const onPage = new Map();
/** Each app’s latest hint, so a block rebuilt around the app shows it before the app reports its parts again. */
const hints = new Map();

/**
 * Rebuilds a review block (#1726). An app review keeps its app: the new block is built without one, and what’s around
 * the app moves into the block on the page, so the app’s frame never leaves it. Moving or replacing a frame reloads
 * it, and what the person did in the app went with it, on every comment action. Any other review is replaced whole.
 * @param {string} itemId @param {HTMLElement} node  the block this render made @param {() => HTMLElement} build
 * @returns {HTMLElement}  the block on the page
 */
export function rerenderAround(itemId, node, build) {
  const cur = node.isConnected ? node : (onPage.get(itemId) ?? node);
  const app = cur.querySelector('.app-review-wrap > .rv-app');
  keeping = app ? { itemId, key: app.dataset.app } : null;
  let n;
  try {
    n = build();
  } finally {
    keeping = null;
  }
  const slot = app ? n.querySelector('.app-review-wrap > .rv-app[data-kept]') : null;
  if (!app || !slot) {
    cur.replaceWith(n);
    onPage.delete(itemId);
    return n;
  }
  graft(cur, n, app, slot);
  onPage.set(itemId, cur);
  return cur;
}

/**
 * Makes old look like new, keeping keep where new has slot: on the way down to it, each element takes new’s attributes
 * and its other children. Only the elements around the app are rebuilt; the app’s own element stays where it is.
 * @param {Element} old @param {Element} next @param {Element} keep @param {Element} slot
 */
function graft(old, next, keep, slot) {
  if (next === slot) return;
  const oldWay = [...old.children].find((c) => c.contains(keep));
  const newWay = [...next.children].find((c) => c.contains(slot));
  if (!oldWay || !newWay) throw new Error('The review’s block changed shape around its app.');
  for (const a of [...old.attributes]) if (!next.hasAttribute(a.name)) old.removeAttribute(a.name);
  // lint-allow dom: the names and values are copied from the block Postbox’s own render just built with h(), never from agent data.
  for (const a of [...next.attributes]) old.setAttribute(a.name, a.value);
  const kids = [...next.childNodes];
  const at = kids.indexOf(newWay);
  for (const c of [...old.childNodes]) if (c !== oldWay) c.remove();
  oldWay.before(...kids.slice(0, at));
  oldWay.after(...kids.slice(at + 1));
  graft(oldWay, newWay, keep, slot);
}

/**
 * The app and its comments, by anchor.
 * @param {any} b  the review block
 * @param {{ itemId: string, d: any, done: boolean, rerender: () => void, threadBox: (key: any) => HTMLElement }} env
 */
export function reviewApp(b, { itemId, d, done, rerender, threadBox }) {
  const key = `${b.appId}:${done ? 'answered' : 'review'}`;
  // Rebuilt around the app on the page (rerenderAround): this one is only a place for it, and mounts nothing.
  const kept = keeping?.itemId === itemId && keeping.key === key;
  const appEl = h('div.rv-app', { 'data-app': key, ...(kept ? { 'data-kept': '' } : {}) });
  const pins = h('div.rv-pins');
  const anchors = new Set(
    [...(b.threads ?? []).map((t) => t.anchor), ...d.comments.map((c) => c.anchor), ...(d.composing ? [d.composing] : [])].filter(Boolean),
  );
  for (const a of anchors) pins.append(h('div', h('span.small.dim', 'On ', h('b', a)), threadBox(a)));
  if (done && !anchors.size) pins.append(h('p.small.dim', 'No comments.'));
  // Open, the review always takes a comment on the whole app, the only way to comment on one that names no parts. The
  // button comes first, so the hint under it changes without moving it.
  const hint = h('p.small.dim', { 'data-app-hint': b.appId }, hints.get(b.appId) ?? '');
  const onWhole = () => {
    startComment(d, WHOLE_APP);
    rerender();
  };
  if (!done) pins.append(h('div', h('button.btn.sm', { type: 'button', onclick: onWhole }, 'Comment on the whole app')), hint);
  if (!kept)
    mountApp(appEl, b.appId, {
      review: !done,
      // The app reports the parts it names once its page has loaded, and again each time it names them, after an await
      // say. The hint follows the latest: every one for this app on the page, since a block rebuilt around the app
      // (rerenderAround) has a new hint, and the next build starts from the latest.
      onAnchors: (names) => {
        const text = names.length ? 'Or click a highlighted part of the app to comment on it.' : 'This app marks no parts to comment on.';
        hints.set(b.appId, text);
        for (const el of document.querySelectorAll(`[data-app-hint="${CSS.escape(b.appId)}"]`)) if (el.textContent !== text) el.textContent = text;
      },
      onPin: (anchor) => {
        if (!done) {
          startComment(d, anchor);
          rerender();
        }
      },
    });
  return h('div.app-review-wrap', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, appEl, pins);
}
