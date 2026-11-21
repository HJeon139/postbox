// An app in a review: the app in review mode, where its registered anchors carry name tags, and the comments on each
// anchor beside it (designs/agent-apps.md, the review block). An app that names no parts says so, and the person
// comments on the whole app instead (#855).

import { mountApp } from './apps.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';

/** The anchor of a comment on the whole app, for an app that names no parts: what the agent reads in the answer. */
export const WHOLE_APP = 'the whole app';

/**
 * The app and its comments, by anchor.
 * @param {any} b  the review block
 * @param {{ d: any, done: boolean, rerender: () => void, threadBox: (key: any) => HTMLElement }} env
 */
export function reviewApp(b, { d, done, rerender, threadBox }) {
  const appEl = h('div');
  const pins = h('div.rv-pins');
  const anchors = new Set(
    [...(b.threads ?? []).map((t) => t.anchor), ...d.comments.map((c) => c.anchor), ...(d.composing ? [d.composing] : [])].filter(Boolean),
  );
  for (const a of anchors) pins.append(h('div', h('span.small.dim', 'On ', h('b', a)), threadBox(a)));
  if (done && !anchors.size) pins.append(h('p.small.dim', 'No comments.'));
  // Open, the review always takes a comment on the whole app, the only way to comment on one that names no parts. The
  // button comes first, so the hint under it changes without moving it.
  const hint = h('p.small.dim');
  const onWhole = () => {
    startComment(d, WHOLE_APP);
    rerender();
  };
  if (!done) pins.append(h('div', h('button.btn.sm', { type: 'button', onclick: onWhole }, 'Comment on the whole app')), hint);
  mountApp(appEl, b.appId, {
    review: !done,
    // The app reports the parts it names once its page has loaded, and again each time it names them, after an await
    // say. The hint follows the latest, in place: a rerender would reload the app, which reports again.
    onAnchors: (names) => {
      const text = names.length ? 'Or click a highlighted part of the app to comment on it.' : 'This app marks no parts to comment on.';
      if (hint.textContent !== text) hint.textContent = text;
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
