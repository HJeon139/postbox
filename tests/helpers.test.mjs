// Cutting text to a length (server/helpers.mjs, clip and clipText) ends before a character, never inside the
// surrogate pair of one past U+FFFF, which would leave half of it, a lone surrogate (#1052).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, clipText } from '../server/helpers.mjs';

const PAIR = '\u{1F600}';

test('#1052 clip and clipText end before an emoji whose pair the cut would split', () => {
  // The cut keeps n - 1 units: the 199th is the emoji’s first half.
  assert.equal(clip(`${'a'.repeat(198)}${PAIR}bb`, 200), `${'a'.repeat(198)}…`);
  assert.equal(clipText(`${'a'.repeat(8)}${PAIR}bb`, 10), `${'a'.repeat(8)}…`);
});

test('#1052 clip and clipText keep an emoji the cut doesn’t split, and text within the limit', () => {
  assert.equal(clip(`${'a'.repeat(197)}${PAIR}bb`, 200), `${'a'.repeat(197)}${PAIR}…`);
  assert.equal(clipText(`${'a'.repeat(7)}${PAIR}bb`, 10), `${'a'.repeat(7)}${PAIR}…`);
  assert.equal(clipText(`a${PAIR}`, 10), `a${PAIR}`);
});

test('#1052 clip and clipText drop a lone first half already at the cut, and cut nothing to nothing', () => {
  assert.equal(clip('ab\uD83Dcd', 4), 'ab…');
  assert.equal(clipText('ab\uD83Dcd', 4), 'ab…');
  assert.equal(clip('', 4), '');
  assert.equal(clipText('', 4), '');
});
