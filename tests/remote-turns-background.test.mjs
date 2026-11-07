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
  const { r, clock, turn } = await quietTurn([...waiting, listed([{ task_id: 'b1', description: name }])]);
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

test('#847 a turn quiet before its result isn’t excused by a listed task: it may be hung mid-turn', async () => {
  const result = recorded.findIndex((l) => l.includes('"type":"result"'));
  const midTurn = recorded.slice(0, result);
  assert.ok(
    midTurn.some((l) => l.includes('"background_tasks_changed"') && !l.includes('"tasks":[]')),
    'a task is listed',
  );
  const { r, clock, turn } = await quietTurn(midTurn);
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
  assert.match(r.se().currentStep, /^Stopped: no output for 15 min/);
});

test('#847 each task’s 2 h counts from when it was first listed: one that ends doesn’t pass its time to the next', async () => {
  const { r, clock, turn } = await quietTurn([
    ...waiting.slice(0, -1).filter((l) => !l.includes('"background_tasks_changed"')),
    listed([{ task_id: 'a', description: 'Task A' }]),
    waiting.at(-1),
  ]);
  const t0 = clock.now;
  const say = async (tasks, at) => {
    clock.now = t0 + at;
    r.d.append(turn, listed(tasks));
    await until(() => r.d.turns.get(turn).acked === r.d.turns.get(turn).out.at(-1).next, 'the line to be applied');
  };
  await say(
    [
      { task_id: 'a', description: 'Task A' },
      { task_id: 'b', description: 'Task B' },
    ],
    60 * MIN,
  );
  await say([{ task_id: 'b', description: 'Task B' }], 90 * MIN);
  // Listed again later: its own time stands, not this event’s.
  await say([{ task_id: 'b', description: 'Task B' }], 150 * MIN);
  clock.now = t0 + 170 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'B has waited 110 min, though A was listed 170 min ago');
  clock.now = t0 + 181 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop at B’s own 2 h');
  await settled(r);
  assert.match(r.se().currentStep, /\(Task B\) ran past 2 h/);
});

test('#847 once the model works again after its result, a listed task no longer excuses quiet', async () => {
  // The model woken again (here by a recorded stream event from its next reply) is mid-turn: quiet then may be hung.
  const working = recorded.slice(ended + 1).find((l) => l.startsWith('{"type":"stream_event"'));
  const { r, clock, turn } = await quietTurn([...waiting, working]);
  clock.now += 20 * MIN;
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
  assert.match(r.se().currentStep, /^Stopped: no output for 15 min/);
});
