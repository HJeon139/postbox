// The runtime’s remote turns (#120, the plan’s L5; tests/remote-turns.test.mjs says how): a turn’s states on its host
// (Hung, Sign-in needed, Interrupted), and Stop on one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIRO_CAPABILITIES, KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { RemoteTurns } from '../server/remote/turns.mjs';
import { escapeRegExp } from '../shared/regex.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { HOST, MIN, messageOf, rig, running, settled, sleep, starts, until } from './remote-turns-helpers.mjs';

// ── 3. Turn states ───────────────────────────────────────────────────────────────────

test('#120 L5: a turn quiet for the host’s stallTimeout is Hung: stopped through the daemon, with the last line’s time', async () => {
  const r = rig();
  let now = Date.UTC(2026, 9, 23, 9, 0);
  r.rt.remote.now = () => now;
  const turn = await running(r);
  await until(() => r.d.received.some((m) => m.type === 'ack' && m.turn === turn), 'the stream to be applied');
  now += 14 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'not yet quiet for 15 minutes');
  // Waiting on you isn’t hung.
  const id = r.d.prompt(turn);
  await until(() => r.store.items(r.t.id).some((i) => i.remote?.prompt === id), 'the card');
  now += 30 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0, 'a card is open');
  const card = r.store.items(r.t.id).find((i) => i.remote?.prompt === id);
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the daemon’s stop');
  await settled(r);
  const last = new Date(Date.UTC(2026, 9, 23, 9, 0)).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const text = `Stopped: no output for 15 min (the last at ${last})`;
  assert.equal(r.se().remoteTurn.state, 'hung');
  assert.equal(r.se().currentStep, text);
  assert.ok(r.store.items(r.t.id).some((i) => i.kind === 'agent' && i.note === text));
  assert.ok(r.notes.some((n) => n.text === text));
  assert.equal(r.f.calls.length, 0, 'never the local kill or ps');
});

test('#120 L5: an open tool call is a sign of work for an adapter that prints nothing while one runs (Kiro), not for Claude Code', async () => {
  assert.equal(KIRO_CAPABILITIES.remote.work, 'open-tool-call');
  const r = rig();
  let now = 1_000_000;
  r.rt.remote.now = () => now;
  const turn = await running(r);
  // The whole stream applied first: a line that came after the clock moved would be a sign of life (under load).
  await until(() => r.d.turns.get(turn).acked === r.d.turns.get(turn).out.at(-1).next, 'the stream to be applied');
  const live = r.rt.turns.get(r.se().id).remote;
  assert.equal(live.work, 'events');
  // The rule, as a Kiro turn would have it: a step still running holds off Hung.
  const kiro = new KiroCliAdapter({ bin: 'kiro-cli', workRoot: '/tmp/pb-remote-never', models: [] });
  const other = new RemoteTurns(r.rt);
  live.work = other.begin({ sessionId: 'x', remote: null }, r.host.id, kiro).work;
  other.close();
  assert.equal(live.work, 'open-tool-call');
  // The step itself, not steps[0]: the stream’s own Bash step comes first once it’s applied.
  const step = { id: 's1', label: 'Run the tests', state: 'running' };
  r.rt.turns.get(r.se().id).steps.push(step);
  now += 60 * MIN;
  r.rt.remote.checkStalls();
  assert.equal(r.d.stops.length, 0);
  step.state = 'done';
  r.rt.remote.checkStalls();
  await until(() => r.d.stops.includes(turn), 'the stop');
  await settled(r);
});

/** The fixture’s stream, ending with the sign-in error the adapter names (capabilities.remote.signInError) instead of
 * its result: no host has recorded one yet, so it’s the recorded result line with those fields. */
const signInLines = () => {
  const lines = fixtureLines();
  const i = lines.findIndex((l) => JSON.parse(l).type === 'result');
  const res = JSON.parse(lines[i]);
  lines[i] = JSON.stringify({ ...res, is_error: true, error: 'authentication_failed', result: 'Failed to authenticate.' });
  return lines.slice(0, i + 1);
};

test('#120 L5: the harness’s sign-in error is Sign-in needed; with no signInCheck it waits for the person’s Resume', async () => {
  const r = rig({ daemon: { lines: signInLines() } });
  const turn = await running(r);
  r.d.end(turn, { code: 1, signal: null });
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'signin');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, new RegExp(`^Sign-in needed on ${escapeRegExp(HOST)}`));
  assert.deepEqual(failed.remote, { state: 'signin', hostId: r.host.id });
  // The host comes back, and time passes: no check, so no resume.
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  r.rt.remote.now = () => Date.now() + 60 * MIN;
  r.rt.remote.tick();
  await sleep(30);
  assert.equal(starts(r.d).length, 1);
  // The person resumes: the turn starts with why the last one stopped.
  r.rt.resumeRemote(r.se().id);
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  const text = messageOf(starts(r.d)[1]);
  assert.match(text, /stopped before it finished, because the sign-in on that host had run out/);
  assert.equal(starts(r.d)[1].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, undefined);
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});

test('#120 L5: after Sign-in needed a failed signInCheck never resumes; a passing one does', async () => {
  const r = rig({ daemon: { lines: signInLines() }, signIn: { ok: false, code: 1, at: 1 } });
  const turn = await running(r);
  // The check ran before the turn, and its failure is a warning, not a refusal.
  assert.ok(r.notes.some((n) => n.title === `Sign-in on ${HOST} may have run out`));
  r.d.end(turn, { code: 1, signal: null });
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'signin');
  let now = Date.now();
  r.rt.remote.now = () => now;
  for (let i = 0; i < 4; i++) {
    r.hosts.emit('status', r.host.id, { state: 'connected' });
    now += 10 * MIN;
    r.rt.remote.tick();
    await sleep(10);
  }
  assert.ok(r.hosts.calls.signIn >= 5, `checks run: ${r.hosts.calls.signIn}`);
  assert.equal(starts(r.d).length, 1, 'a failed check never resumes');
  r.hosts.signIn = { ok: true, code: 0, at: 2 };
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  assert.match(messageOf(starts(r.d)[1]), /sign-in on that host had run out/);
  r.d.end(starts(r.d)[1].turn);
  await settled(r);
});

test('#120 L5: Interrupted (no runner, no exit.json) resumes on its own once the host is back, continuing the cut-off turn', async () => {
  const r = rig();
  const turn = await running(r);
  await until(() => r.se().backendState?.claudeSessionId, 'the session ID');
  r.hosts.state = 'reconnecting';
  r.d.interrupt(turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  const failed = r.store.items(r.t.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(failed.error, new RegExp(`^Interrupted on ${escapeRegExp(HOST)}`));
  await sleep(20);
  assert.equal(starts(r.d).length, 1, 'the host isn’t back yet');
  r.hosts.state = null;
  r.hosts.emit('status', r.host.id, { state: 'connected' });
  await until(() => starts(r.d).length === 2, 'the resumed turn');
  const again = starts(r.d)[1];
  assert.equal(again.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1');
  assert.ok(again.argv.includes('--resume'));
  assert.match(messageOf(again), /^\[Postbox\] Your last turn on host\.example\.com was interrupted before it finished/);
  r.d.end(again.turn);
  await settled(r);
  assert.equal(r.se().remoteTurn.state, 'done');
});

// ── 5. Stop ──────────────────────────────────────────────────────────────────────────

test('#120 L5: Stop on a remote turn is a plain stop: no keep-jobs ask, no keep list, and a job’s own Stop says why not', async () => {
  const r = rig();
  const turn = await running(r);
  const live = r.rt.turns.get(r.se().id);
  r.rt.recordJob(live, { id: 'job1', toolUseId: 'tu_1', label: 'Serve', command: 'npm start', state: 'running' });
  await assert.rejects(r.rt.stopJob(r.se().id, 'job1'), (e) => e.status === 409 && /A job on a host stops with its turn/.test(e.message));
  const res = r.rt.requestStop(r.se().id);
  assert.equal(res.ask, undefined);
  assert.equal(res.stopped, true);
  assert.equal(live.keepJobs.size, 0);
  assert.deepEqual(live.abort.signal.reason.keepJobs, []);
  await until(() => r.d.stops.includes(turn), 'the daemon’s stop');
  await settled(r);
  assert.equal(r.f.calls.length, 0);
  // A stop with jobs: 'keep' that reaches it anyway keeps nothing.
  const t2 = await running(r, 'again');
  r.rt.stop(r.se().id, { jobs: 'keep' });
  await until(() => r.d.stops.includes(t2), 'the second stop');
  await settled(r);
});
