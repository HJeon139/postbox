// #674: Codex compacts by itself inside an ordinary turn when a thread grows past its limit, and goes on; it doesn’t
// fail every turn, as Kiro did before #544’s start-over. The room shows that compaction as it shows /compact’s (#425):
// one compaction line, then the reply after it. Replayed from a recorded Codex 0.167.0 session with the limit forced
// small (tests/fixtures/codex-app-server/auto-compact.jsonl, and its README for how it was made).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { answersOf, CODEX_ROOT, playedServers } from './codex-fixture.mjs';

/**
 * App-servers that answer as the recording did, one Postbox turn each, as Postbox starts one per turn: the thread it
 * opened, or the same thread resumed, and the recording’s next turn (request ids 3 to 5).
 */
function recordedServers() {
  const a = answersOf('auto-compact.jsonl');
  return playedServers(
    [3, 4, 5].map((id) => ({ initialize: a.get(1), 'thread/start': a.get(2), 'thread/resume': a.get(2)?.slice(0, 1), 'turn/start': a.get(id) })),
  );
}

/** The room after the recording’s three messages, each sent once the turn before it ended. */
async function roomAfterThreeTurns(spawnImpl = recordedServers()) {
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl })),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: CODEX_ROOT });
  const p = rt.createPersona({ handle: 'gpt', backend: 'codex' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const replies = () => store.items(t.id).filter((x) => x.kind === 'agent' && x.status !== 'streaming');
  for (const [n, text] of ['Remember the word heron. Reply with just OK.', 'Reply with just OK.', 'What word did I ask you to remember?'].entries()) {
    rt.sendMessage(t.id, { text });
    for (let i = 0; i < 400 && (rt.turns.size || replies().length <= n); i++) await new Promise((r) => setTimeout(r, 5));
  }
  return store.items(t.id);
}

test('#674 Codex’s own compaction inside an ordinary turn shows once, then the reply after it', async () => {
  const items = await roomAfterThreeTurns();
  const shown = items.filter((x) => x.kind === 'agent' || x.variant === 'compaction');
  assert.deepEqual(
    shown.map((x) => (x.kind === 'agent' ? `reply: ${x.text}` : 'compaction')),
    ['reply: OK', 'compaction', 'reply: OK', 'compaction', 'reply: heron'],
    'the recording’s turns 2 and 3 each compacted before the reply',
  );
  for (const line of shown.filter((x) => x.variant === 'compaction')) {
    assert.match(line.summary, /Codex summarized/);
    assert.equal(line.kept, undefined, 'Codex counts nothing, so nothing is made up');
  }
  assert.deepEqual(
    shown.filter((x) => x.variant === 'compaction').map((x) => x.n),
    [1, 2],
  );
  assert.ok(!items.some((x) => x.kind === 'agent' && x.status === 'failed'), 'no turn failed');
});
