// #731: the server’s Mermaid parser runs in a worker, one diagram at a time, each within a time limit. A diagram that
// hangs the parser ends its worker and gets no answer; the diagrams queued behind it go to a new worker and get
// theirs. The worker here is a stand-in whose “hang” never answers (tests/fixtures/diagram-parse/hanging-worker.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntaxError, useParser } from '../server/diagram-parse.mjs';

test('#731 the diagrams queued behind one that hangs the parser still get their answers', async () => {
  useParser({ url: new URL('./fixtures/diagram-parse/hanging-worker.mjs', import.meta.url), ms: 300 });
  const answers = await Promise.all(['hang', 'first', 'second'].map((src) => syntaxError(src)));
  assert.deepEqual(answers, [null, { message: 'Parse error in first', line: null }, { message: 'Parse error in second', line: null }]);
  // And the parser goes on working after it.
  assert.deepEqual(await syntaxError('later'), { message: 'Parse error in later', line: null });
});
