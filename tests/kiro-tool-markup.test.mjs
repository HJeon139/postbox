// #1916: on deepseek-3.2, Kiro’s message chunks end with the model’s raw tool-call marker, `<｜DSML｜function_calls`, where
// it then called a tool, and the reply the person saw carried it. The turn is the one recorded for #489
// (tests/fixtures/kiro-cli/tool-load-deepseek.jsonl, kiro-cli 3.6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { markupHolder } from '../server/adapters/model-markup.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

/** What a chunk shows once its turn has gone on to a tool call (markupHolder). @param {string} text */
function shown(text) {
  let said = '';
  const markup = markupHolder((e) => {
    said += e.text;
  });
  markup.chunk(text);
  markup.letGo();
  return said;
}

test('#1916 the recorded reply reaches the person without DeepSeek’s tool-call marker', () => {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000 });
  for (const e of fixture('tool-load-deepseek')) m.push(e);
  assert.equal(m.error, null);
  assert.doesNotMatch(ctx.calls.text, /DSML|function_calls/);
  assert.match(ctx.calls.text, /then show a choice block with "Yes" as an option\.(\n|$)/, 'the words before it are kept');
  assert.match(ctx.calls.text, /The block is now waiting for the person's answer\./);
});

test('#1916 only a marker that ends a chunk goes: a reply that mentions it keeps its words', () => {
  assert.equal(shown('Done.\n\n<｜DSML｜function_calls'), 'Done.');
  assert.equal(shown('Done. <｜DSML｜function_calls  \n'), 'Done.');
  assert.equal(shown('<｜DSML｜function_calls'), '');
  // DeepSeek-V3.2’s tag in full closes with `>`; the recording has it without.
  assert.equal(shown('Done.\n\n<｜DSML｜function_calls>'), 'Done.');
  for (const kept of [
    'DeepSeek writes `<｜DSML｜function_calls` before a call.',
    'Plain words.',
    'A <tag> at the end',
    'Ends with <｜DSML｜',
    'The log shows `<｜DSML｜function_calls',
  ])
    assert.equal(shown(kept), kept, kept);
});
