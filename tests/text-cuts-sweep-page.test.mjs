// #1686, the reopened sweep: text the page cuts by length, only at a whole character (cutText). Each case puts an emoji
// across its site’s cut. The page’s other cuts (a queued message’s button name, the raw block, a selection’s quote on
// a comment’s meta line, an allowed call’s line) build DOM, and have no case yet: the pull request that converted them
// lists them under “Not done” (#1686).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageModule } from './page-module.mjs';
import { across, EMOJI, whole } from './text-cuts-fixture.mjs';

test('#1686 two bars of one backend tell their hosts apart by a start of each name that ends on a whole character', async () => {
  const { namesAt } = await pageModule('quota-fit.mjs');
  const bar = (/** @type {string} */ host) => ({ backend: 'claude-code', full: 'Claude Code', host });
  const names = namesAt([bar('ab'), bar(`a${EMOJI}`)], true);
  assert.equal(names?.length, 2, 'both bars are named');
  for (const name of names ?? []) whole(name, `the bar named ${name}`);
});

test('#1686 a comment on a long selection names its place by the quote, cut whole', async () => {
  const { placeOf } = await pageModule('review-comment-box.mjs', ['dom.mjs']);
  whole(placeOf({ quote: across(59) }, { format: 'markdown' }), 'the place');
});
