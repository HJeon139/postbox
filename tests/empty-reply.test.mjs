// #485: an agent’s reply was posted with no text. A Claude Code turn of about 45 minutes ended with its report as the
// text after its last command, and Postbox posted the reply as an item with no text, so the report reached no one.
// Whatever the backend did, a turn that ends with no reply is never posted as an empty message: it ends as a failed
// reply that says so, with Retry; the item keeps the turn’s last raw lines for diagnosis; and the agent hears of it at
// its next turn.
//
// The stream is tests/fixtures/claude-code/background-moved.jsonl, a Bash call moved to the background at its timeout,
// cut from the HotpotQA UAT of 22 October 2026 (tests/agent-activity.test.mjs). As recorded, both its results carry the
// agent’s reply in `result.result` with no text event before them, so Postbox reads a turn of steps and no text, as in
// #485. Whether Claude Code itself streamed text there isn’t known: the recording was cut.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const LINES = readFileSync(new URL('fixtures/claude-code/background-moved.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);

/** A claude that plays the recorded stream, then exits 0. */
const spawnImpl = () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
  setImmediate(() => {
    for (const l of LINES) child.stdout.write(`${l}\n`);
    child.stdout.end();
    setTimeout(() => child.emit('close', 0), 5);
  });
  return child;
};

function setup() {
  const store = new Store(null);
  const adapters = new AdapterRegistry().register(new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-485/workspaces', spawnImpl }));
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters, corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp/pb-test-485' });
  const p = rt.createPersona({ handle: 'critic', backend: 'claude-code', folder: '/tmp/pb-test-485' });
  const t = rt.createThread({ projectId: 'p1', title: 'Q4 review', personaIds: [p.id] });
  return { store, rt, t, se: rt.sessionsIn(t.id)[0] };
}
const settle = async (rt) => {
  for (let i = 0; i < 400 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
};

test('#485: a turn that ends with steps and no reply text ends as a failed reply that says so, with Retry', async () => {
  const { store, rt, t, se } = setup();
  rt.sendMessage(t.id, { text: '@critic check the Q4 claim' });
  await settle(rt);
  const replies = store.items(t.id).filter((i) => i.kind === 'agent' && i.sessionId === se.id);
  assert.ok(replies.length, 'the turn posted its steps');
  assert.ok(
    replies.every((i) => !i.text?.trim()),
    'as recorded, no text reaches Postbox: the case #485 is about',
  );
  const last = replies.at(-1);
  assert.equal(last.status, 'failed', 'never left as a finished reply with no text');
  assert.equal(last.error, '@critic’s turn ended without a reply.');
  assert.ok(last.asked, 'Retry can send what it was asked again');
  assert.equal(store.state.sessions[se.id].needs?.kind, 'failed', 'the person is told, as for any failed reply');
});

test('#485: the empty reply keeps the turn’s raw ending, and the agent hears of it at its next turn', async () => {
  const { store, rt, t, se } = setup();
  rt.sendMessage(t.id, { text: '@critic check the Q4 claim' });
  await settle(rt);
  const last = store
    .items(t.id)
    .filter((i) => i.kind === 'agent' && i.sessionId === se.id)
    .at(-1);
  assert.equal(last.rawEnding?.backend, 'claude-code');
  assert.ok(last.rawEnding.lines.length > 0 && last.rawEnding.lines.length <= 12);
  assert.equal(last.rawEnding.lines.at(-1), LINES.at(-1).slice(0, 1000), 'its last line is the stream’s last event, bounded');
  assert.ok(
    last.rawEnding.lines.every((l) => l.length <= 1000),
    'each line is bounded',
  );
  assert.ok(
    (store.state.sessions[se.id].context ?? []).some((c) => /your last turn .* ended without a reply/i.test(c)),
    JSON.stringify(store.state.sessions[se.id].context),
  );
});
