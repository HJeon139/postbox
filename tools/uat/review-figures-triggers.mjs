// #780's UAT triggers (tools/uat/triggers.mjs has what a trigger is): an agent showed a review block carrying two or
// more images from its folder, and its draft names each by its name or kept ref, so Preview draws them from the item's
// route. One is for an agent on this computer, one for an agent on a host: a block's turn ran on a host when Postbox
// recorded a remote turn for it (tools/uat/remote-facts.mjs, remoteTurns). They read the items and the sessions; the
// runner doesn't record whether the page loaded each image, so that is the tester's to check.

import { escapeHtml, renderMarkdown } from '../../shared/markdown.mjs';
import { reviewFileKeys } from '../../shared/review-files.mjs';
import { itemsUnderTest, labelOf, remoteTurns } from './remote-facts.mjs';
import { clip } from './trigger-facts.mjs';

/** The four types Postbox keeps a review's file as (server/review-files.mjs), never SVG. */
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const isFigure = (x) => typeof x?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) && IMAGE.test(String(x?.type));

/** Whether the draft, as Preview renders it (shared/review-files.mjs), draws every file from the item's route. */
function namesEach(it) {
  const keys = reviewFileKeys(it.threadId, it) ?? {};
  const html = renderMarkdown(it.block.content, { files: keys });
  return it.files.every((x) => html.includes(`src="${escapeHtml(keys[x.name].url)}"`));
}

const figureReview = (it) =>
  it.kind === 'block' &&
  it.valid !== false &&
  it.block?.type === 'review' &&
  (it.block.format ?? 'markdown') === 'markdown' &&
  typeof it.block.content === 'string' &&
  (it.files ?? []).length >= 2 &&
  it.files.every(isFigure) &&
  namesEach(it);

/** Each such review, from a turn on a host or here. @param {'host'|'here'} where */
const figuresShown = (where) => (f) => {
  const recs = remoteTurns(f);
  return itemsUnderTest(f)
    .filter(figureReview)
    .map((it) => ({ it, rec: recs.get(it.turnId) ?? null }))
    .filter(({ rec }) => (where === 'host') === !!rec)
    .map(({ it, rec }) => ({
      at: Number.isFinite(it.at) ? it.at : null,
      evidence: `@${it.handle}’s review “${clip(it.block.title ?? it.block.id, 60)}”${rec ? `, from ${labelOf(f, rec.hostId) ?? 'a host'},` : ''} shows ${it.files.length} figures: ${it.files.map((x) => x.name).join(', ')}.`,
    }));
};

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const REVIEW_FIGURE_TRIGGERS = {
  'review-figures-shown': {
    issue: 780,
    says: 'an agent on this computer showed a review block with two or more images from its folder, and its draft names each',
    recorded: (f) => !!f.state,
    run: figuresShown('here'),
  },
  'host-review-figures-shown': {
    issue: 780,
    says: 'an agent on a host showed a review block with two or more images from its folder there, and its draft names each',
    recorded: (f) => Boolean(f.hosts?.hosts?.length),
    run: figuresShown('host'),
  },
};
