// #1543, findings 2 and 3: a Codex turn’s text and its empty-reply diagnosis.
// The stream is tests/fixtures/codex-app-server/turn.jsonl, the app-server’s shape the Codex adapter’s other tests use.
// No recording has an empty or blank item/agentMessage/delta: those here are added by hand, to hold the mapper to what
// claude-stream.mjs already does, where only a delta with text marks its message as streamed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { keepShape } from '../server/adapters/setup.mjs';

const LINES = readFileSync(new URL('fixtures/codex-app-server/turn.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const NOTES = LINES.filter((l) => l.method);

/** The reply’s text, from a mapper fed `events`. */
function replyOf(/** @type {any[]} */ events) {
  let text = '';
  const mapper = createCodexMapper({ activity: () => {}, status: () => {}, text: (d) => (text += d), state: {} });
  for (const e of events) mapper.push(e);
  return text;
}

const AT = NOTES.findIndex((n) => n.method === 'item/agentMessage/delta');
/** The recorded turn with its one delta replaced by these. */
const withDeltas = (/** @type {string[]} */ deltas) => [
  ...NOTES.slice(0, AT),
  ...deltas.map((delta) => ({ method: 'item/agentMessage/delta', params: { ...NOTES[AT].params, delta } })),
  ...NOTES.slice(AT + 1),
];

test('#1543: an empty or blank delta doesn’t hide the message’s completed text', () => {
  // Only the completed item carries the text.
  for (const blank of [[''], ['   '], ['\n\n'], ['', ' ', '\n']]) assert.equal(replyOf(withDeltas(blank)), 'Hello from Codex.', JSON.stringify(blank));
  // A delta with text still streams it once, not again at completion.
  assert.equal(replyOf(NOTES), 'Hello from Codex.');
});

test('#1543: a streamed reply keeps its whitespace, blank deltas included', () => {
  assert.equal(replyOf(withDeltas(['\n', 'Hello', '\n\n', ' ', 'from Codex.'])), '\nHello\n\n from Codex.');
});

test('#1543: an empty reply’s diagnosis keeps each Codex event’s method', () => {
  const ctx = { rawTail: [] };
  for (const l of LINES) keepShape(ctx, JSON.stringify(l));
  const methods = ctx.rawTail.map((l) => JSON.parse(l).method).filter((m) => m !== undefined);
  // The recording is 11 lines, within the 12 the tail keeps, so every event is there.
  assert.equal(ctx.rawTail.length, LINES.length);
  assert.deepEqual(
    methods,
    NOTES.map((n) => n.method),
  );
  // The text is still kept only as its length.
  assert.ok(!ctx.rawTail.some((l) => l.includes('Hello from Codex')));
});

test('#1543: a tool argument named method keeps only its length', () => {
  const ctx = { rawTail: [] };
  const secret = 'POST https://example.test/token?k=abc';
  // A Codex MCP call whose argument is named `method`, in the shape item/started reports a call (codex-events.mjs).
  const call = { type: 'mcpToolCall', id: 'call_1', server: 'http', tool: 'request', arguments: { method: secret } };
  keepShape(ctx, JSON.stringify({ method: 'item/started', params: { threadId: 'thr_postbox_1', item: call } }));
  const kept = JSON.parse(ctx.rawTail[0]);
  assert.equal(kept.method, 'item/started');
  assert.ok(!ctx.rawTail[0].includes('example.test'), ctx.rawTail[0]);
});

test('#1543: a line too long to keep whole still keeps its method', () => {
  const ctx = { rawTail: [] };
  // Enough fields that the whole shape passes the 1,000-character line, so only the top level is kept.
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, { n: i }]));
  keepShape(ctx, JSON.stringify({ method: 'item/completed', params: { threadId: 'thr_postbox_1', item: { id: 'msg_1', ...many } } }));
  const kept = JSON.parse(ctx.rawTail[0]);
  assert.equal(kept.method, 'item/completed');
  assert.equal(kept.params, '{…}', 'the compact form, not the whole shape');
});
