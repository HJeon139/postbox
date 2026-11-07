// A Claude Code turn waiting on a background task isn’t hung (#847): after its result, Claude Code keeps the process
// alive until the task ends and prints nothing meanwhile. The recorded stream background-done.jsonl, cut where the task
// is still open (its result sent, line 33), is that wait. Up to QUIET.backgroundMax; past it the turn is stopped,
// naming the task.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { RemoteTurns } from '../server/remote/turns.mjs';
import { QUIET } from '../shared/limits.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { MIN, restarted, rig, settled, startUp, until } from './remote-turns-helpers.mjs';

const recorded = fixtureLines('background-done');
const ended = recorded.findIndex((l, i) => i > 20 && l.includes('"background_tasks_changed"'));
/** The stream up to the task’s end: its result sent, the task still listed. */
const waiting = recorded.slice(0, ended - 1);
const listed = (tasks) => JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks, uuid: 'u', session_id: 's' });

/** A turn on the host whose stream is `lines`, all applied, at a clock the test moves. */
async function quietTurn(lines) {
  const r = rig({ daemon: { lines } });
  const clock = { now: 1_000_000 };
  r.rt.remote.now = () => clock.now;
  r.rt.sendMessage(r.t.id, { text: 'hi' });
  await until(() => r.d.turns.size === 1, 'the turn to start on the host');
  const turn = [...r.d.turns.keys()][0];
  await until(() => r.d.turns.get(turn).acked === r.d.turns.get(turn).out.at(-1).next, 'the stream to be applied');
  return { r, clock, turn };
}

test('#847 the recorded wait: a result sent with a background task open isn’t stopped after stallTimeout', async () => {
  assert.ok(
    waiting.some((l) => l.includes('"type":"result"')),
    'the cut stream has its result',
  );
  const { r, clock, turn } = await quietTurn(waiting);
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'waiting on the task');
  r.d.end(turn);
  await settled(r);
});

test('#847 a background task open past QUIET.backgroundMax is stopped as hung, naming it', async () => {
  const { r, clock, turn } = await quietTurn(waiting);
  clock.now += QUIET.backgroundMax - MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'still under the ceiling');
  clock.now += 2 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'hung');
  assert.match(r.se().currentStep, /^Stopped: a background task \(.+\) ran past 2 h with no output$/);
});

test('#847 once the list is empty again, the quiet rule is today’s', async () => {
  const { r, clock, turn } = await quietTurn(recorded.slice(0, ended + 1));
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
  assert.match(r.se().currentStep, /^Stopped: no output for 15 min/);
});

test('#847 the words in an assistant’s text don’t count as a listed task', async () => {
  const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: listed([{ task_id: 'b1', description: 'x' }]) }] } });
  const { r, clock, turn } = await quietTurn([...recorded.slice(0, 19), text]);
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
});

test('#847 an adapter without the capability (Kiro) isn’t excused by the same line', async () => {
  const { r, clock, turn } = await quietTurn(waiting);
  const live = r.rt.turns.get(r.se().id).remote;
  const kiro = new KiroCliAdapter({ bin: 'kiro-cli', workRoot: '/tmp/pb-remote-never', models: [] });
  const other = new RemoteTurns(r.rt);
  const asKiro = other.begin({ sessionId: 'x', remote: null }, r.host.id, kiro);
  other.close();
  assert.equal(asKiro.backgroundTasks, null);
  // The same stream, taken in as Kiro’s would be: its line names no task.
  live.backgroundTasks = asKiro.backgroundTasks;
  live.background = null;
  r.d.append(
    turn,
    waiting.find((l) => l.includes('"background_tasks_changed"')),
  );
  await until(() => r.d.turns.get(turn).acked === r.d.turns.get(turn).out.at(-1).next, 'the line to be applied');
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
});

test('#847 the stop text quotes the agent’s description as one clipped line, without control characters', async () => {
  const name = `Wait\u0007 for\nCI\u202e on [a](https://x.example)${'.'.repeat(200)}`;
  const { r, clock, turn } = await quietTurn([...recorded.slice(0, 19), listed([{ task_id: 'b1', description: name }])]);
  clock.now += QUIET.backgroundMax + MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
  const said = r.se().currentStep;
  assert.doesNotMatch(said, /[\p{Cc}\u202a-\u202e]/u);
  const quoted = said.match(/\((.*)\) ran past/)[1];
  assert.ok(quoted.length <= 80, `${quoted.length} characters`);
  assert.ok(quoted.startsWith('Wait for CI on [a]'), quoted);
});

test('#847 after a Postbox restart, the replayed stream lists the task again, so the turn isn’t stopped', async () => {
  const { store, d } = restarted();
  d.append('host-turn-1', listed([{ task_id: 'b1', description: 'Wait for the gate' }]));
  const r = rig({ store, d });
  const clock = { now: 1_000_000 };
  r.rt.remote.now = () => clock.now;
  startUp(r);
  const card = () => r.store.items(r.t.id).find((i) => i.kind === 'permission');
  await until(() => r.rt.permissionWaits.has(card().id), 'the card to wait again');
  r.rt.resolvePermission(r.t.id, card().id, 'allow');
  await until(() => d.answers.length === 1, 'the answer');
  await until(() => d.turns.get('host-turn-1').acked === d.turns.get('host-turn-1').out.at(-1).next, 'the replay to be applied');
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(d.stops.length, 0, 'the replayed list holds it');
  d.end('host-turn-1');
  await settled(r);
});
