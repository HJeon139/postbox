// Whether an agent’s session says it waits on background work (#189), from streams recorded on claude 2.1.296 (the
// fixtures tests/agent-activity.test.mjs describes):
// - background-subagent.jsonl: one Agent call with run_in_background, whose subagent runs on after the agent’s reply;
// - background-done.jsonl: a Bash call with run_in_background, whose job runs on after the turn’s result.
// The session’s state stays “tool” while only that work runs, so delivery waits as it did; `background` is what lets
// the ring say “Waiting on background work” rather than “Calling tools”.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';
import { pageView } from './page-view.mjs';

const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const WAITING = /^Waiting for (a|\d+) background (subagent|job)s?$/;

/**
 * Replays a recorded stream through the runtime, as one turn of a mock backend, and returns the agent’s session as a
 * page holds it after each line, and the session once the turn has ended.
 * @param {string} name
 */
async function replayTurn(name) {
  const lines = fixture(name);
  const store = new Store(null);
  const page = pageView(store);
  /** @type {any[]} */
  const seen = [];
  let se;
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({
      name: 'mock',
      async folderFor() {
        return null;
      },
      async deliver(_session, _message, ctx) {
        const m = createStreamMapper(ctx);
        for (const e of lines) {
          m.push(e);
          seen.push({ ...(await page.settled()).sessions[se.id] });
        }
      },
    }),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  se = arrange.agentIn(rt, t.id);
  rt.sendMessage(t.id, { text: 'start some background work' });
  for (let i = 0; i < 200 && !(seen.length === lines.length && !arrange.running(rt, se.id)); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.length, lines.length);
  return { lines, seen, after: (await page.settled()).sessions[se.id] };
}

/** The lines after which the agent waits on background work alone: its state is “tool” and its step says so. */
const waitingLines = (seen) => seen.flatMap((x, i) => (x.state === 'tool' && WAITING.test(x.currentStep ?? '') ? [i] : []));

test('#189: the agent’s session says it waits on background work from its reply to its subagent’s notification', async () => {
  const { lines, seen, after } = await replayTurn('background-subagent');
  const waits = waitingLines(seen);
  const ended = lines.findIndex((e) => e.subtype === 'task_notification' && e.tool_use_id === 'toolu_01HFxPBV7hB6m5y1ZFJvnrZm');
  // Fixture lines 30 to 46, counted from 1: from the reply that called no tool until the agent thinks about what its
  // subagent returned, one line after the subagent’s notification (line 45).
  assert.deepEqual([waits[0], ended, waits.at(-1)], [29, 44, 45]);
  for (const i of waits) assert.equal(seen[i].background, true, `waiting on background work after line ${i + 1}`);
  // Before, it thinks, writes and calls tools of its own; after, it thinks about what came back, and nothing is stale.
  for (const [i, x] of seen.entries()) if (!waits.includes(i)) assert.notEqual(x.background, true, `not waiting after line ${i + 1}: ${x.state}`);
  assert.notEqual(after.background, true, 'the turn’s end leaves no flag');
});

test('#189: the agent’s session says it waits on background work while its background Bash job runs on', async () => {
  const { lines, seen, after } = await replayTurn('background-done');
  const waits = waitingLines(seen);
  const result = lines.findIndex((e) => e.type === 'result');
  const done = lines.findIndex((e) => e.subtype === 'task_notification');
  // Fixture lines 32 to 35, counted from 1: from the turn’s result until the agent thinks about what its job printed,
  // one line after the job’s notification (line 34).
  assert.deepEqual([waits[0], done, waits.at(-1)], [result, 33, 34]);
  for (const i of waits) assert.equal(seen[i].background, true, `waiting on background work after line ${i + 1}`);
  for (const [i, x] of seen.entries()) if (!waits.includes(i)) assert.notEqual(x.background, true, `not waiting after line ${i + 1}: ${x.state}`);
  assert.notEqual(after.background, true, 'the turn’s end leaves no flag');
});
