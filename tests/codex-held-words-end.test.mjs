// Words another Codex message held back while one streamed mid-sentence (#1293) reach the reply however the turn ends:
// by Stop, by a crash of the app server, or at its turn/completed. Released only at turn/completed, a Stop or a crash
// lost them, where main showed them, spliced (the integrator’s review of #1393). Driven through the real CodexAdapter
// and the fake app server, as tests/codex.test.mjs is.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

const line = (/** @type {any} */ o) => `${JSON.stringify(o)}\n`;
const delta = (/** @type {string} */ itemId, /** @type {string} */ text) => ({ method: 'item/agentMessage/delta', params: { itemId, delta: text } });
// Message A streams mid-sentence; B, written meanwhile, waits; A goes on, still mid-sentence.
const STREAM = [delta('A', 'Looking at the files'), delta('B', 'Tests pass: 12 of 12. '), delta('B', 'Lint is clean.'), delta('A', ' in the')];

/** A turn of the real adapter with the stream above written, before it ends. */
async function midTurn() {
  const seen = [];
  const child = fakeAppServer(seen, { hold: true });
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => child });
  const abort = new AbortController();
  const said = { text: '' };
  const ctx = {
    persona: { handle: 'critic', model: 'gpt-5.6-terra' },
    project: { folder: `${CODEX_ROOT}/project` },
    handles: ['critic'],
    state: {},
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s3&turn=t1',
    text: (/** @type {string} */ x) => {
      said.text += x;
    },
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
  const turn = adapter.deliver({}, { kind: 'user', text: 'go' }, ctx).catch((/** @type {any} */ e) => e);
  while (!seen.some((x) => x.method === 'turn/start')) await new Promise((r) => setImmediate(r));
  for (const m of STREAM) child.stdout.write(line(m));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(said.text, 'Looking at the files in the', 'B waits while A is open and mid-sentence');
  return { child, abort, said, turn };
}

const WHOLE = 'Looking at the files in the\n\nTests pass: 12 of 12. Lint is clean.';

test('#1293: Stop writes the words a message held back, before the runtime stops taking the turn’s text', async () => {
  const { abort, said, turn } = await midTurn();
  abort.abort();
  // The runtime marks the turn closed as soon as its abort returns, and takes no text after: they’re in by now.
  assert.equal(said.text, WHOLE);
  await turn;
});

test('#1293: a crash of the app server writes the words a message held back, before the turn fails', async () => {
  const { child, said, turn } = await midTurn();
  child.emit('close', 1);
  const err = await turn;
  assert.match(String(err?.message), /exited with code 1/);
  assert.equal(said.text, WHOLE);
});
