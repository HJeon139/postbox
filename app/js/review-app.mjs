// An app in a review: the app in review mode, where its registered anchors carry name tags, and the comments on each
// anchor beside it (designs/agent-apps.md, the review block).

import { mountApp } from './apps.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';

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
  if (!anchors.size) pins.append(h('p.small.dim', done ? 'No comments.' : 'Click a highlighted part of the app to comment on it.'));
  mountApp(appEl, b.appId, {
    review: !done,
    onPin: (anchor) => {
      if (!done) {
        startComment(d, anchor);
        rerender();
      }
    },
  });
  return h('div.app-review-wrap', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } }, appEl, pins);
}
