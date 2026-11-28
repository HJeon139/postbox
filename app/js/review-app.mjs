// An app in a review: the app in review mode, where its registered anchors carry name tags, and the comments on each
// anchor beside it (designs/agent-apps.md, the review block). An app that names no parts says so, and the person
// comments on the whole app instead (#855), or marks a point or a box anywhere on it (#856, review-marks.mjs).

import { REGION_ANCHOR } from '/shared/review-regions.mjs';
import { mountApp } from './apps.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';
import { attachMarks, markControls, paintMarks, regionNote, versionOf } from './review-marks.mjs';
import { regionsOf, renumberDraft } from './review-region-numbers.mjs';

/** The anchor of a comment on the app as a whole: what the agent reads in the answer. */
export const WHOLE_APP = 'the whole app';

/** The review being rebuilt around its live app (rerenderAround): its item, and which app and mode that app shows. */
let keeping = null;
/** An item’s block on the page, when a rerender kept the one that was there: a newer render’s handlers find it here.
 * Held weakly so leaving a room lets its detached block and layer go. @type {Map<string, WeakRef<HTMLElement>>} */
const onPage = new Map();
/**
 * Each review’s latest hint, by its item, so a block rebuilt around the app shows it: a kept app doesn’t report its parts
 * again. By item, not app: another review of the same app, mounted afresh, starts its own hint and leaves this one.
 */
const hints = new Map();

/**
 * Rebuilds a review block (#1726). An app review keeps its app: the new block is built without one, and what’s around
 * the app moves into the block on the page, so the app’s frame never leaves it. Moving or replacing a frame reloads
 * it, and what the person did in the app went with it, on every comment action. Any other review is replaced whole.
 * @param {string} itemId @param {HTMLElement} node  the block this render made @param {() => HTMLElement} build
 * @returns {HTMLElement}  the block on the page
 */
export function rerenderAround(itemId, node, build) {
  // A block the page let go of (a server update re-rendered it, or the conversation changed) is let go of here too.
  for (const [id, ref] of onPage) if (!ref.deref()?.isConnected) onPage.delete(id);
  const keptEl = onPage.get(itemId)?.deref();
  const cur = node.isConnected ? node : (keptEl ?? node);
  // Only a mounted app is kept: one that said it isn’t available mounts afresh, in case it is now.
  const app = cur.querySelector('.app-review-wrap > .rv-app:has(> .app-body)');
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
  onPage.set(itemId, new WeakRef(cur));
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
 * @param {{ itemId: string, d: any, done: boolean, rerender: () => HTMLElement, threadBox: (key: any) => HTMLElement }} env
 */
export function reviewApp(b, { itemId, d, done, rerender, threadBox }) {
  const key = `${b.appId}:${done ? 'answered' : 'review'}`;
  // Rebuilt around the app on the page (rerenderAround): this one is only a place for it, and mounts nothing.
  const kept = keeping?.itemId === itemId && keeping.key === key;
  const appEl = h('div.rv-app', { 'data-app': key, ...(kept ? { 'data-kept': '' } : {}) });
  const pins = h('div.rv-pins');
  if (!done) renumberDraft(b, d);
  const anchors = new Set(
    [...(b.threads ?? []).map((t) => t.anchor), ...d.comments.map((c) => c.anchor), ...(d.composing ? [d.composing] : [])].filter(Boolean),
  );
  const version = versionOf(b, done);
  const regions = regionsOf(b, d);
  for (const a of anchors) {
    // Whether the region is drawn at the frame’s width is said once the frame is laid out (paintMarks).
    const note = regions.has(a) ? h('span', { 'data-region-note': a }, regionNote(regions.get(a), version, null)) : null;
    pins.append(h('div', h('span.small.dim', 'On ', h('b', a), note), threadBox(a)));
  }
  if (done && !anchors.size) pins.append(h('p.small.dim', 'No comments.'));
  // Open, the review always takes a comment on the whole app, the only way to comment on one that names no parts. The
  // button comes first, so the hint under it changes without moving it.
  // An app mounted afresh hasn’t said what it names yet: what an earlier version named isn’t its hint.
  if (!kept) hints.delete(itemId);
  const hint = h('p.small.dim', { 'data-app-hint': itemId }, hints.get(itemId) ?? '');
  const onWhole = () => {
    startComment(d, WHOLE_APP);
    rerender();
  };
  const marks = { b, d, done, version, rerender };
  if (!done) {
    const mark = markControls(itemId, marks);
    pins.append(h('div.rv-app-actions', h('button.btn.sm', { type: 'button', onclick: onWhole }, 'Comment on the whole app'), mark.button), hint);
    if (mark.help) pins.append(mark.help, mark.status);
  }
  if (!kept)
    mountApp(appEl, b.appId, {
      review: !done,
      // Answered reviews stay uncapped in height too, so regions marked near the bottom stay over what was marked (#856).
      fullHeight: true,
      // The app reports the parts it names once its page has loaded, and again each time it names them, after an await
      // say. The hint follows the latest: every one for this review on the page, since a block rebuilt around the app
      // (rerenderAround) has a new hint, and the next build starts from the latest.
      onAnchors: (names) => {
        const text = names.length ? 'Or click a highlighted part of the app to comment on it.' : 'This app marks no parts to comment on.';
        hints.set(itemId, text);
        for (const el of document.querySelectorAll(`[data-app-hint="${CSS.escape(itemId)}"]`)) if (el.textContent !== text) el.textContent = text;
      },
      onPin: (anchor) => {
        // A region is marked on Postbox’s layer, never named by the app (#856).
        if (!done && !REGION_ANCHOR.test(anchor)) {
          startComment(d, anchor);
          rerender();
        }
      },
    });
  // Over the app’s frame, a layer of Postbox’s own draws the regions marked on it, and takes the marking (#856).
  if (!kept) attachMarks(itemId, appEl);
  paintMarks(itemId, { ...marks, pins });
  return h('div.app-review-wrap', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, appEl, pins);
}
