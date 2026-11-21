// #1543, findings 2 and 3: a Codex turn’s text and its empty-reply diagnosis.
// The stream is tests/fixtures/codex-app-server/turn.jsonl, the app-server’s shape the Codex adapter’s other tests use.
// No recording has an empty item/agentMessage/delta: the empty one here is added by hand, to hold the mapper to what
// claude-stream.mjs already does, where only a delta with text marks its message as streamed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCodexMapper } from '../server/adapters/codex.mjs';

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

test('#1543: an empty delta doesn’t hide the message’s completed text', () => {
  const at = NOTES.findIndex((n) => n.method === 'item/agentMessage/delta');
  const empty = { method: 'item/agentMessage/delta', params: { ...NOTES[at].params, delta: '' } };
  // The recorded order with the delta’s text gone: only the completed item carries it.
  const events = [...NOTES.slice(0, at), empty, ...NOTES.slice(at + 1)];
  assert.equal(replyOf(events), 'Hello from Codex.');
  // A delta with text still streams it once, not again at completion.
  assert.equal(replyOf(NOTES), 'Hello from Codex.');
});
