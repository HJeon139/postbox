// #1934: Kiro streams most models in token-sized message chunks (tests/fixtures/kiro-cli/mcp-failed.jsonl has 81 of
// them), and DeepSeek’s tool-call marker could arrive split, `<｜DSML` in one chunk and `｜function_calls` in the next,
// so neither chunk ended with the whole marker and it reached the reply. These replays take the turn recorded for #489
// (tool-load-deepseek.jsonl, kiro-cli 3.6.2), whose chunks are whole messages, and split its message chunks into
// token-sized ones, marker included, as Kiro sends other models’.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

/** The recorded turn with each message chunk cut into pieces of `size` characters. @param {number} size */
function split(size) {
  return fixture('tool-load-deepseek').flatMap((e) => {
    const u = e.data?.update;
    if (u?.sessionUpdate !== 'agent_message_chunk') return [e];
    const text = String(u.content.text);
    const pieces = [];
    for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
    return pieces.map((piece) => ({ ...e, data: { ...e.data, update: { ...u, content: { ...u.content, text: piece } } } }));
  });
}

/** The reply the person sees from a replay. @param {any[]} lines */
function reply(lines) {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000 });
  for (const e of lines) m.push(e);
  return ctx.calls.text;
}

test('#1934 a marker split across token-sized chunks doesn’t reach the reply, whatever the split', () => {
  const whole = reply(fixture('tool-load-deepseek'));
  for (const size of [1, 2, 3, 4, 5, 7, 11]) {
    const said = reply(split(size));
    assert.doesNotMatch(said, /DSML|function_calls|｜/, `chunks of ${size}`);
    assert.equal(said, whole, `chunks of ${size} read as the whole-message chunks do`);
  }
});

test('#1934 what looked like a marker’s start, and wasn’t one, reaches the reply whole', () => {
  const lines = fixture('first');
  const chunk = lines.find((e) => e.data?.update?.sessionUpdate === 'agent_message_chunk');
  assert.ok(chunk, 'the recorded first turn has a message chunk');
  const at = lines.indexOf(chunk);
  const piece = (/** @type {string} */ text) => ({ ...chunk, data: { ...chunk.data, update: { ...chunk.data.update, content: { type: 'text', text } } } });
  for (const [parts, said] of [
    [['a < b'], 'a < b'],
    [['less: <', ' more'], 'less: < more'],
    [['fullwidth <｜', 'D is a glyph'], 'fullwidth <｜D is a glyph'],
    [['the turn ends on <'], 'the turn ends on <'],
    [['quoted `<｜DSML', '｜function_calls` in code'], 'quoted `<｜DSML｜function_calls` in code'],
  ])
    assert.equal(reply([...lines.slice(0, at), ...parts.map(piece), ...lines.slice(at + 1)]), said, JSON.stringify(parts));
});

test('#1934 held words still reach the reply when the turn ends right after them, as finished or failed', () => {
  const lines = fixture('first');
  const chunk = lines.find((e) => e.data?.update?.sessionUpdate === 'agent_message_chunk');
  const finished = lines.find((e) => e.type === 'runFinished');
  assert.ok(chunk && finished, 'the recorded first turn has a message chunk and its end');
  const said = { ...chunk, data: { ...chunk.data, update: { ...chunk.data.update, content: { type: 'text', text: 'It ends on <' } } } };
  const start = lines.slice(0, lines.indexOf(chunk));
  assert.equal(reply([...start, said, finished]), 'It ends on <');
  assert.equal(reply([...start, said, { type: 'runError', data: { message: 'stopped' } }]), 'It ends on <');
});
