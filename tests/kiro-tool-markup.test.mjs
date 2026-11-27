// #1916: on deepseek-3.2, Kiro’s message chunks end with the model’s raw tool-call marker, `<｜DSML｜function_calls`, where
// it then called a tool, and the reply the person saw carried it. The turn is the one recorded for #489
// (tests/fixtures/kiro-cli/tool-load-deepseek.jsonl, kiro-cli 3.6.2).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { withoutToolMarkup } from '../server/adapters/model-markup.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

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
  assert.equal(withoutToolMarkup('Done.\n\n<｜DSML｜function_calls'), 'Done.');
  assert.equal(withoutToolMarkup('Done. <｜DSML｜function_calls  \n'), 'Done.');
  assert.equal(withoutToolMarkup('<｜DSML｜function_calls'), '');
  for (const kept of ['DeepSeek writes `<｜DSML｜function_calls` before a call.', 'Plain words.', 'A <tag> at the end', 'Ends with <｜DSML｜'])
    assert.equal(withoutToolMarkup(kept), kept, kept);
});
