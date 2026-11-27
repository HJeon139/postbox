// A link’s text in rendered Markdown: what it may hold. tests/markdown.test.mjs is at its ceiling.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown as md } from '../shared/markdown.mjs';

test('a link’s text gets no glossary term inside it, so no term sits in a term or a link', () => {
  const glossary = [{ key: 'observation-budget', term: 'observation budget' }];
  assert.equal(
    md('[observation budget](term:observation-budget)', { glossary }),
    '<p><span class="term" tabindex="0" data-term="observation-budget">observation budget</span></p>',
  );
  assert.equal(
    md('[the observation budget](https://example.com/b)', { glossary }),
    '<p><a href="https://example.com/b" target="_blank" rel="noopener noreferrer">the observation budget</a></p>',
  );
});
