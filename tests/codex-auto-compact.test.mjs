// #674: Codex compacts by itself inside an ordinary turn when a thread grows past its limit, and goes on; it doesn’t
// fail every turn, as Kiro did before #544’s start-over. The room shows that compaction as it shows /compact’s (#425):
// one compaction line, then the reply after it. Replayed from a recorded Codex 0.167.0 session with the limit forced
// small (tests/fixtures/codex-app-server/auto-compact.jsonl, and its README for how it was made).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { CODEX_ROOT } from './codex-fixture.mjs';

const RECORDED = readFileSync(new URL('fixtures/codex-app-server/auto-compact.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/**
 * The notifications of the recording’s turn n (1 to 3): from turn/start’s answer, whose id is n + 2, to that turn’s
 * turn/completed. @param {number} n
 */
function turnNotes(n) {
  const from = RECORDED.findIndex((l) => l.id === n + 2);
  const to = RECORDED.findIndex((l, i) => i > from && l.method === 'turn/completed');
  return RECORDED.slice(from + 1, to + 1);
}

/**
 * App-servers that answer as the recording did, one Postbox turn each, as Postbox starts one per turn: the thread it
 * opened or resumed, and the recording’s next turn.
 */
function recordedServers() {
  let turn = 0;
  return () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => child.emit('close', 0);
    const write = (/** @type {any} */ m) => child.stdout.write(`${JSON.stringify(m)}\n`);
    const answer = { initialize: 1, 'thread/start': 2, 'thread/resume': 2 };
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const req = JSON.parse(line);
        if (req.id === undefined) continue;
        if (req.method === 'turn/start') {
          turn += 1;
          write({ ...RECORDED.find((l) => l.id === turn + 2), id: req.id });
          const notes = turnNotes(turn);
          setImmediate(() => notes.forEach(write));
          continue;
        }
        const recorded = RECORDED.find((l) => l.id === answer[req.method]);
        write(recorded ? { ...recorded, id: req.id } : { id: req.id, result: { data: [], nextCursor: null } });
      }
    });
    return child;
  };
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
