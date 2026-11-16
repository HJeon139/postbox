// Two Codex narrations streaming at once (#1293). An agent narrating several parallel calls sent two agent messages
// whose deltas interleaved, and the reply spliced them word by word into an unreadable wall of text in a real room.
//
// The stream here is built, not recorded: no recorded Codex turn interleaves (tests/fixtures/codex-app-server). Its
// lines are the app server’s own shapes from ledger-edits.jsonl (item/started of an agentMessage with its id, then
// item/agentMessage/delta with its itemId, then item/completed with its whole text), and the interleaving is #1293’s
// report: two items, each with its own itemId, sending alternating chunks of a few words, the second starting before the
// first has ended. If a recording is made later, it replaces this stream.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexMapper } from '../server/adapters/codex.mjs';

const A = 'msg_a1293';
const B = 'msg_b1293';
const started = (id) => ({ method: 'item/started', params: { item: { type: 'agentMessage', id, text: '', phase: 'commentary' } } });
const delta = (itemId, text) => ({ method: 'item/agentMessage/delta', params: { itemId, delta: text } });
const completed = (id, text) => ({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text, phase: 'commentary' } } });
const READ_A = "I'll reconstruct only days 1–3 from my own artifacts and messages, using the index solely to locate the ranges.";
const READ_B = "I'm continuing the reconstruction from my own messages. Evidence uses the relevant ranges.";

/** The mapper with a fake turn context, and what the reply received. */
function codex() {
  const out = { text: '' };
  const mapper = createCodexMapper({
    activity: () => {},
    status: () => {},
    text: (/** @type {string} */ d) => {
      out.text += d;
    },
    state: {},
  });
  return { push: (/** @type {any} */ m) => mapper.push(m), out };
}

/** Both narrations, their chunks alternating a few words at a time. */
function interleaved({ push }) {
  push(started(A));
  push(delta(A, "I'll reconstruct only days 1–3 from"));
  push(started(B));
  for (const [id, text] of [
    [B, "I'm continuing"],
    [A, ' my own artifacts'],
    [B, ' the reconstruction'],
    [A, ' and messages, using'],
    [B, ' from my own messages.'],
    [A, ' the index solely to locate the'],
    [B, ' Evidence uses'],
    [A, ' ranges.'],
    [B, ' the relevant ranges.'],
  ]) {
    push(delta(id, text));
  }
  push(completed(A, READ_A));
  push(completed(B, READ_B));
  push({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
}

test('#1293: two Codex narrations streaming at once reach the reply sentence by sentence, never spliced word by word', () => {
  const c = codex();
  interleaved(c);
  const paragraphs = c.out.text.split('\n\n');
  // Every sentence of each narration arrives whole, in its own order.
  const sentences = (/** @type {string} */ s) => s.match(/[^.]+\./g)?.map((x) => x.trim()) ?? [];
  const got = paragraphs.flatMap(sentences);
  for (const whole of [...sentences(READ_A), ...sentences(READ_B)]) assert.ok(got.includes(whole), `“${whole}” arrives whole in:\n${c.out.text}`);
  assert.equal(got.length, sentences(READ_A).length + sentences(READ_B).length, `nothing else, and nothing twice:\n${c.out.text}`);
});

test('#1293: one narration still streams as it’s written, and the next block after it starts at once', () => {
  const c = codex();
  c.push(started(A));
  c.push(delta(A, 'Reading the files'));
  assert.equal(c.out.text, 'Reading the files', 'live, word by word');
  c.push(delta(A, ' now.'));
  c.push(completed(A, 'Reading the files now.'));
  c.push(started(B));
  c.push(delta(B, 'Done'));
  assert.equal(c.out.text, 'Reading the files now.\n\nDone', 'the next message isn’t held');
});

test('#1293: a message that ends mid-sentence lets the waiting one in when its item completes', () => {
  const c = codex();
  c.push(started(A));
  c.push(delta(A, 'Looking at the files'));
  c.push(started(B));
  c.push(delta(B, 'Here is what I found.'));
  assert.equal(c.out.text, 'Looking at the files', 'B waits while A is open and mid-sentence');
  c.push(completed(A, 'Looking at the files'));
  assert.equal(c.out.text, 'Looking at the files\n\nHere is what I found.');
});

test('#1293: a message waiting behind one that never ends a sentence is written at the turn’s end', () => {
  const c = codex();
  c.push(started(A));
  c.push(delta(A, 'Looking at the files'));
  c.push(started(B));
  c.push(delta(B, 'Here is what I found.'));
  assert.equal(c.out.text, 'Looking at the files');
  c.push({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); // no item/completed for A
  assert.equal(c.out.text, 'Looking at the files\n\nHere is what I found.');
});

test('#1293: a message that takes the reply back starts its paragraph at its word, with no space', () => {
  const c = codex();
  c.push(started(A));
  c.push(delta(A, 'Alpha one'));
  c.push(started(B));
  c.push(delta(B, 'Beta one.'));
  c.push(delta(A, ' done.'));
  c.push(delta(A, ' Alpha two.'));
  assert.equal(c.out.text, 'Alpha one done.\n\nBeta one.\n\nAlpha two.');
});
