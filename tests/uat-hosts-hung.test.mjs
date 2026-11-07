// #872’s UAT fault and trigger: stop-runner (tools/uat/hosts-watch.mjs) sends SIGSTOP to the runner of host1’s newest
// turn, so its daemon finds it silent past the ceiling, kills it, and ends the turn interrupted; host-hung-killed
// (tools/uat/triggers-hung.mjs) fires when Postbox then resumed that turn on its own, once, and the resumed turn
// finished. Built on tests/uat-hosts-facts.mjs’s run.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCRIPTS } from '../tools/uat/hosts-ssh.mjs';
import { fault, stopRunner } from '../tools/uat/hosts-watch.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { SCHEMA } from '../tools/uat/tester.mjs';
import { HOST_TRIGGERS } from '../tools/uat/triggers-host.mjs';
import { facts } from './uat-hosts-facts.mjs';

const trigger = HOST_TRIGGERS['host-hung-killed'];
const OLD = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
/** A session event of @researcher’s on host1, as the run’s history keeps it (server/room-events.mjs, keepEvent). */
const ev = (seq, turn, rtTurn, state) => ({ seq, type: 'session', data: { id: 's1', state: 'gen', remoteTurn: { hostId: 'ho_1', turn, rtTurn, state } } });
const agent = (id, turnId, status, at) => ({ id, kind: 'agent', handle: 'researcher', sessionId: 's1', turnId, status, at });

/**
 * host1: @researcher’s turn tu_h1 (host turn OLD) started at 3500, its runner stopped at 4000, the turn ended
 * interrupted, then Postbox resumed it as tu_h2 (host turn NEW) at 5000, which finished.
 * @param {{ fault?: any, events?: any[], items?: any[] }} [o]
 */
function hung({ fault: x = {}, events, items } = {}) {
  const f = facts();
  f.hosts.faults = x === null ? [] : [{ fault: 'stop-runner', label: 'host1', at: 4000, pid: '4100', turn: OLD, states: [], recovered: null, ...x }];
  f.events.push(
    ...(events ?? [ev(10, OLD, 'tu_h1', 'running'), ev(11, OLD, 'tu_h1', 'interrupted'), ev(12, NEW, 'tu_h2', 'running'), ev(13, NEW, 'tu_h2', 'done')]),
  );
  f.state.items.t1 = [...f.state.items.t1, ...(items ?? [agent('i4', 'tu_h1', 'error', 3500), agent('i5', 'tu_h2', 'done', 5000)])];
  return f;
}

test('#872 host-hung-killed fires when a stopped runner’s turn ended interrupted once, was resumed alone, and finished', () => {
  const hits = trigger.run(hung());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].at, 5000);
  assert.match(hits[0].evidence, /host1: @researcher’s runner \(process 4100\) stopped; its turn ended interrupted once, Postbox resumed it on its own/);
  assert.equal(trigger.issue, 872);
  assert.equal(trigger.recorded(hung()), true);
});

test('#872 host-hung-killed is silent when the fault never ran', () => {
  assert.deepEqual(trigger.run(hung({ fault: null })), [], 'no fault, though the turn was interrupted and resumed');
  assert.deepEqual(trigger.run(hung({ fault: { fault: 'kill-daemon' } })), [], 'another fault');
  assert.deepEqual(trigger.run(hung({ fault: { turn: NEW } })), [], 'the fault stopped another turn');
  assert.deepEqual(trigger.run({}), [], 'a run without hosts');
});

test('#872 host-hung-killed is silent when a second agent started before the old turn ended', () => {
  const beside = [ev(10, OLD, 'tu_h1', 'running'), ev(11, NEW, 'tu_h2', 'running'), ev(12, OLD, 'tu_h1', 'interrupted'), ev(13, NEW, 'tu_h2', 'done')];
  assert.deepEqual(trigger.run(hung({ events: beside })), [], 'the new turn started beside the old one');
  const again = [
    ev(10, OLD, 'tu_h1', 'running'),
    ev(11, OLD, 'tu_h1', 'interrupted'),
    ev(12, OLD, 'tu_h1', 'running'),
    ev(13, NEW, 'tu_h2', 'running'),
    ev(14, NEW, 'tu_h2', 'done'),
  ];
  assert.deepEqual(trigger.run(hung({ events: again })), [], 'the old turn started again after it ended');
});

test('#872 host-hung-killed is silent with no resume, or one that didn’t finish or that the person asked for', () => {
  const ended = [ev(10, OLD, 'tu_h1', 'running'), ev(11, OLD, 'tu_h1', 'interrupted')];
  assert.deepEqual(trigger.run(hung({ events: ended, items: [agent('i4', 'tu_h1', 'error', 3500)] })), [], 'never resumed');
  const never = [ev(10, OLD, 'tu_h1', 'running'), ev(12, NEW, 'tu_h2', 'running'), ev(13, NEW, 'tu_h2', 'done')];
  assert.deepEqual(trigger.run(hung({ events: never })), [], 'the old turn never read interrupted');
  const failed = [agent('i4', 'tu_h1', 'error', 3500), agent('i5', 'tu_h2', 'error', 5000)];
  assert.deepEqual(trigger.run(hung({ items: failed })), [], 'the resumed turn didn’t finish');
  const asked = [agent('i4', 'tu_h1', 'error', 3500), { id: 'u9', kind: 'user', text: '@researcher go on', at: 4500 }, agent('i5', 'tu_h2', 'done', 5000)];
  assert.deepEqual(trigger.run(hung({ items: asked })), [], 'a message of the person’s came first');
});

/** A host that answers SCRIPTS.stopRunner as the given output. */
const answers =
  (stdout, code = 0, ran = []) =>
  async (/** @type {string} */ dest, /** @type {string} */ script) => {
    ran.push([dest, script]);
    return { code, stdout, stderr: code ? 'kill: denied' : '' };
  };

test('#872 the stop-runner fault runs its script on the host, and refuses a host that had Postbox before the run', async () => {
  const ran = [];
  const h = { label: 'host1', destination: 'host-a.example.com' };
  assert.deepEqual(await stopRunner(h, answers(`turn ${OLD}\nstopped 4100\n`, 0, ran)), { pid: '4100', turn: OLD });
  assert.deepEqual(ran, [['host-a.example.com', SCRIPTS.stopRunner]]);
  await assert.rejects(
    stopRunner({ ...h, replaceInstall: true }, answers('stopped 1\n', 0, ran)),
    /stop-runner is refused on host1: Postbox was there before this run/,
  );
  assert.equal(ran.length, 1, 'nothing ran on that host');
  assert.equal(await stopRunner(h, answers('none\n')), null, 'no running turn');
  await assert.rejects(stopRunner(h, answers('', 4)), /Couldn’t stop the runner of host1’s newest turn: kill: denied/);
  await assert.rejects(stopRunner(h, answers('stopped 4100\n')), /Couldn’t stop the runner of host1’s newest turn/, 'no turn said');
});

test('#872 the stop-runner script finds the newest running turn’s runner, checks it’s a runner, and sends SIGSTOP', () => {
  const s = SCRIPTS.stopRunner;
  assert.match(s, /"\$HOME"\/\.postbox-remote\/turns\/\*\/runner\.json/);
  assert.match(s, /exit\.json/, 'skips a turn that ended');
  assert.match(s, /-nt/, 'the newest');
  assert.match(s, /\/server\/remote\/host\/runner\.mjs \$t"\)/, 'only that turn’s runner');
  assert.match(s, /kill -STOP "\$p"/);
  assert.match(s, /echo "stopped \$p"/);
});

test('#872 stop-runner through fault() records the process and the turn, and tells the tester what to expect', async () => {
  const ran = [];
  const hr = { hosts: [{ label: 'host1', destination: 'host-a.example.com', id: 'ho_1' }], record: { faults: [] }, placement: {}, log: () => {} };
  const said = await fault(
    /** @type {any} */ (hr),
    { fault: 'stop-runner', target: 'host1' },
    { reload: async () => {} },
    () => {},
    answers(`turn ${OLD}\nstopped 4100\n`, 0, ran),
  );
  assert.deepEqual(ran, [['host-a.example.com', SCRIPTS.stopRunner]]);
  assert.match(said, /^Stopped the runner of host1’s newest turn \(process 4100\)/);
  assert.equal(hr.record.faults.length, 1);
  assert.equal(hr.record.faults[0].fault, 'stop-runner');
  assert.equal(hr.record.faults[0].turn, OLD);
  assert.equal(hr.record.faults[0].pid, '4100');
  const none = await fault(/** @type {any} */ (hr), { fault: 'stop-runner', target: 'host1' }, { reload: async () => {} }, () => {}, answers('none\n'));
  assert.match(none, /There was no runner of host1’s newest turn to stop/);
});

test('#872 the tester can ask for stop-runner, and remotehosts’ last phase plays it', () => {
  const faults = JSON.stringify(SCHEMA).match(/"enum":\["kill-ssh"[^\]]*\]/g) ?? [];
  assert.ok(faults.length >= 2 && faults.every((f) => f.includes('"stop-runner"')), faults.join(' '));
  const scenario = parseScenario(readFileSync(new URL('uat/e2e/scenarios/remotehosts.md', import.meta.url), 'utf8'));
  const last = scenario.phases.at(-1);
  assert.deepEqual(last.triggers, ['host-hung-killed']);
  assert.match(last.text, /fault stop-runner, target host1/);
});
