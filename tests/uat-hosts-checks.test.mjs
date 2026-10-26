// The checks and triggers of the UAT runner’s host mode (#120; tools/uat/checks-remote.mjs, tools/uat/triggers-host.mjs):
// where each turn ran, what a check that can’t see a remote turn says instead of passing, a host’s files in Work, and
// the end-of-run checks over each host. The facts are built here, as the runner gathers them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { keepEvent } from '../tools/uat/history.mjs';
import { triggersFired } from '../tools/uat/triggers.mjs';
import { facts, HT, remote, T } from './uat-hosts-facts.mjs';

const of = (f, check) => runChecks(f, { only: [check] });
const init = (extra = {}) => ({ type: 'system', subtype: 'init', session_id: 'x', tools: [], mcp_servers: [], ...extra });
const edit = (id, path) => ({
  events: [
    { type: 'assistant', timestamp: '2026-10-24T10:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ],
});

test('#120 ran-on-its-host: each turn ran where its agent is placed, from the session’s remoteTurn in the state or the history', () => {
  assert.deepEqual(of(facts(), 'ran-on-its-host'), []);
  // @critic’s turn on host2 with no remote turn, and @developer’s here with one, are each a finding.
  const f = facts({ events: [] });
  f.state.sessions.s3.remoteTurn = remote('ho_1', T.d1, '33333333-3333-4333-8333-333333333333');
  const got = of(f, 'ran-on-its-host');
  assert.deepEqual(
    got.map((x) => [x.key, x.title, x.issue]),
    [
      [T.c1, 'A turn of an agent placed on host2 didn’t run there', 120],
      [T.d1, 'A turn of an agent on this computer ran on a host', 120],
    ],
  );
  assert.match(got[0].evidence, /no remote turn in Postbox’s state or history: it ran on this computer/);
  // On the wrong host.
  const g = facts();
  g.state.sessions.s1.remoteTurn = remote('ho_2', T.r1, HT.r1);
  assert.match(of(g, 'ran-on-its-host')[0].evidence, /ran on host2 \(host turn 1111/);
  // A turn that failed before it reached the host is failed-turn’s, not this check’s.
  const h = facts({ events: [] });
  h.state.items.t1[1].status = 'failed';
  assert.deepEqual(of(h, 'ran-on-its-host'), []);
});

test('#120 settings-leak, mcp-servers-missing and mcp-side-channel judge only turns here, and say how many on a host they couldn’t', () => {
  const remoteStream = { handle: 'researcher', events: [init({ output_style: 'Explanatory' })] };
  const localStream = { handle: 'developer', events: [init({ output_style: 'Learning' })] };
  const f = facts({ streams: [remoteStream, localStream] });
  const leak = of(f, 'settings-leak');
  assert.equal(leak.length, 1);
  assert.match(leak[0].evidence, /output_style: Learning\./);
  // At the end of the run, the remote turns it couldn’t judge are a measurement, never a silent pass.
  f.hosts.ended = true;
  const ended = of(f, 'settings-leak');
  const na = ended.find((x) => x.key === 'not-applicable:remote');
  assert.deepEqual([na?.title, na?.issue, na?.verdict], ['settings-leak: not applicable to 1 remote turn', null, 'measurement']);
  for (const id of ['mcp-servers-missing', 'mcp-side-channel']) {
    const x = of(f, id).find((y) => y.key === 'not-applicable:remote');
    assert.equal(x?.title, `${id}: not applicable to 1 remote turn`, id);
  }
  // Without hosts, every turn is this computer’s, as before.
  const plain = facts({ streams: [remoteStream], hosts: undefined });
  assert.match(of(plain, 'settings-leak')[0].evidence, /Explanatory/);
});

test('#120 work-files-match-stream: a file changed on a host is an edit step there, never a file with a diff', () => {
  const f = facts({
    streams: [
      { handle: 'researcher', ...edit('w1', '/home/user/postbox-uat/x/a.py') },
      { handle: 'developer', ...edit('w2', '/Users/user/w/b.py') },
    ],
  });
  f.state.work = {
    t1: [
      { kind: 'edit', path: '/home/user/postbox-uat/x/a.py' },
      { kind: 'file', path: '/Users/user/w/b.py' },
    ],
  };
  assert.deepEqual(of(f, 'work-files-match-stream'), []);
  f.state.work = { t1: [{ kind: 'file', path: '/home/user/postbox-uat/x/a.py' }] };
  const got = of(f, 'work-files-match-stream');
  assert.deepEqual(
    got.map((x) => x.key),
    ['work-files-match-stream', 'remote-as-file'],
  );
  assert.match(got[0].evidence, /\/Users\/user\/w\/b\.py/);
  f.state.work = { t1: [{ kind: 'file', path: '/Users/user/w/b.py' }] };
  assert.deepEqual(
    of(f, 'work-files-match-stream').map((x) => x.key),
    ['remote-missing'],
  );
});

test('#120 host-turns-listed: each host’s ~/.postbox-remote/turns against the turns Postbox recorded there', () => {
  const f = facts();
  assert.deepEqual(of(f, 'host-turns-listed'), []);
  const old = '44444444-4444-4444-8444-444444444444';
  const stray = '55555555-5555-4555-8555-555555555555';
  f.hosts.before = { host1: [old] };
  f.hosts.listed = { host1: [old, stray], host2: [HT.c1] };
  const got = of(f, 'host-turns-listed');
  assert.deepEqual(
    got.map((x) => x.key),
    ['missing:host1', 'unknown:host1'],
  );
  assert.match(got[0].evidence, new RegExp(HT.r1));
  assert.match(got[1].evidence, new RegExp(stray));
  // A host whose turns couldn’t be listed fails as that, never as a host with none.
  f.hosts.listed.host1 = null;
  assert.deepEqual(
    of(f, 'host-turns-listed').map((x) => x.key),
    ['unlisted:host1'],
  );
});

test('#120 host-done-when: nothing of Postbox after the idle timeout, and no ~/.postbox-remote after Remove', () => {
  const f = facts();
  f.hosts.idle = { host1: { left: [], waited: 200_000 }, host2: { skipped: 'Its idleTimeout is 30 min.' } };
  f.hosts.removed = {
    host1: { confirm: 'Remove a.example.com?', exists: false, left: [] },
    host2: { confirm: 'Remove b.example.com?', exists: false, left: [] },
  };
  assert.deepEqual(
    of(f, 'host-done-when').map((x) => [x.key, x.verdict ?? null]),
    [['idle-skipped:host2', 'measurement']],
  );
  f.hosts.idle.host1.left = ['4100 node /home/user/.postbox-remote/0.24.0/server/remote/host/host.mjs serve'];
  f.hosts.removed.host2 = { confirm: 'Remove b.example.com?', exists: true, left: [] };
  f.hosts.removed.host1 = { error: 'Remove was refused: b.example.com didn’t confirm.' };
  assert.deepEqual(
    of(f, 'host-done-when').map((x) => x.key),
    ['idle:host1', 'remove:host1', 'idle-skipped:host2', 'remove:host2'],
  );
  // What couldn’t be listed (pgrep missing, ssh failing) fails as that, never as nothing running.
  f.hosts.idle.host1 = { left: null, waited: 200_000, unmeasured: 'sh: 1: pgrep: not found' };
  f.hosts.removed.host1 = { confirm: 'Remove a.example.com?', exists: false, left: null, unmeasured: 'sh: 1: pgrep: not found' };
  const got = of(f, 'host-done-when');
  assert.deepEqual(
    got.map((x) => [x.key, x.verdict ?? null]),
    [
      ['idle-unmeasured:host1', null],
      ['remove-unmeasured:host1', null],
      ['idle-skipped:host2', 'measurement'],
      ['remove:host2', null],
    ],
  );
  assert.match(got[0].evidence, /pgrep: not found/);
});

test('#120 a Stop on a host: nothing of the turn left there, and the composer said beforehand that its jobs stop with it', () => {
  const f = facts();
  const note = 'Stop also stops @researcher’s background job on a.example.com: a job on a host stops with its turn.';
  f.hosts.stops = [{ handle: 'researcher', label: 'host1', turnId: T.r1, turn: HT.r1, jobs: 1, note, watched: 4, left: [] }];
  assert.deepEqual(of(f, 'remote-stop-left-processes'), []);
  const fired = triggersFired(f, ['remote-stop-says-jobs', 'remote-stop-no-process-left']);
  assert.ok(fired['remote-stop-says-jobs'] && fired['remote-stop-no-process-left']);
  // Nothing seen under the turn before Stop: it can’t be told what was left, which fails, and the trigger waits.
  f.hosts.stops = [
    {
      handle: 'researcher',
      label: 'host1',
      turnId: T.r1,
      turn: HT.r1,
      jobs: 1,
      note,
      watched: 0,
      left: null,
      unmeasured: 'nothing was seen running under the turn before Stop.',
    },
  ];
  assert.deepEqual(
    of(f, 'remote-stop-left-processes').map((x) => x.key),
    [`unmeasured:${T.r1}`],
  );
  assert.equal(triggersFired(f, ['remote-stop-no-process-left'])['remote-stop-no-process-left'], false);
  f.hosts.stops = [{ handle: 'researcher', label: 'host1', turnId: T.r1, turn: HT.r1, jobs: 1, note: null, watched: 4, left: ['4300 sleep 180'] }];
  assert.deepEqual(
    of(f, 'remote-stop-left-processes').map((x) => x.key),
    [`left:${HT.r1}`, `silent:${HT.r1}`],
  );
  assert.deepEqual(triggersFired(f, ['remote-stop-says-jobs', 'remote-stop-no-process-left']), {
    'remote-stop-says-jobs': false,
    'remote-stop-no-process-left': false,
  });
});

test('#120 faults: recovered ones fire their triggers, a host that never reads Connected again is a finding, and one nothing needed is neither', () => {
  const f = facts();
  f.hosts.faults = [
    { fault: 'kill-ssh', label: 'host2', at: 5000, recovered: true, shown: 'host2 read reconnecting, then connected' },
    { fault: 'kill-daemon', label: 'host1', at: 6000, recovered: false, shown: 'host1 read failed' },
    { fault: 'restart-postbox', label: null, at: 7000, recovered: null, shown: 'No host was connected.' },
  ];
  const fired = triggersFired(f, ['fault-kill-ssh', 'fault-kill-daemon', 'fault-restart-postbox']);
  assert.ok(fired['fault-kill-ssh']);
  assert.equal(fired['fault-kill-daemon'], false);
  assert.equal(fired['fault-restart-postbox'], false);
  assert.deepEqual(
    of(f, 'fault-not-recovered').map((x) => x.title),
    ['After kill-daemon on host1, the host didn’t read Connected again'],
  );
});

test('#120 permission cards from a host: one answered after a minute, and one open across a killed ssh, answered after it', () => {
  const f = facts();
  const card = {
    id: 'p1',
    kind: 'permission',
    handle: 'critic',
    summary: 'run ls -la',
    remote: { hostId: 'ho_2', turn: HT.c1, prompt: 'x' },
    status: 'allowed',
    at: 10_000,
    answeredAt: 50_000,
  };
  f.state.items.t1.push(card);
  assert.equal(triggersFired(f, ['remote-card-after-a-minute'])['remote-card-after-a-minute'], false);
  card.answeredAt = 80_000;
  assert.match(String(triggersFired(f, ['remote-card-after-a-minute'])['remote-card-after-a-minute']?.evidence), /after 70 s/);
  // A card from this computer doesn’t count.
  const here = facts();
  here.state.items.t1.push({ ...card, remote: undefined });
  assert.equal(triggersFired(here, ['remote-card-after-a-minute'])['remote-card-after-a-minute'], false);
  f.hosts.faults = [{ fault: 'kill-ssh', label: 'host2', at: 20_000, recovered: true }];
  assert.ok(triggersFired(f, ['remote-card-while-disconnected'])['remote-card-while-disconnected']);
  f.hosts.faults = [{ fault: 'kill-ssh', label: 'host1', at: 20_000, recovered: true }];
  assert.equal(triggersFired(f, ['remote-card-while-disconnected'])['remote-card-while-disconnected'], false);
  // A kill host2 never noticed (it read Connected throughout) didn’t put the card across a drop.
  f.hosts.faults = [{ fault: 'kill-ssh', label: 'host2', at: 20_000, recovered: null, unseen: true }];
  assert.equal(triggersFired(f, ['remote-card-while-disconnected'])['remote-card-while-disconnected'], false);
  assert.equal(triggersFired(f, ['fault-kill-ssh'])['fault-kill-ssh'], false);
});

test('#120 a turn on each machine, a wake across machines, and an attachment read from its copy on the host', () => {
  const f = facts();
  assert.ok(triggersFired(f, ['turn-on-each-place'])['turn-on-each-place']);
  f.state.items.t1[2].status = 'failed';
  assert.equal(triggersFired(f, ['turn-on-each-place'])['turn-on-each-place'], false);
  const call = (id, name, input) => [
    { type: 'assistant', timestamp: '2026-10-24T10:00:00Z', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ];
  f.streams = [
    { handle: 'critic', events: call('k1', 'mcp__postbox__wake_agent', { handle: 'critic', message: 'self' }) },
    { handle: 'critic', events: call('k2', 'mcp__postbox__wake_agent', { handle: '@researcher', message: 'Rename it.' }) },
    { handle: 'critic', events: call('k3', 'Read', { file_path: `/home/user/.postbox-remote/turns/${HT.c1}/attachments/1-shot.png` }) },
  ];
  assert.match(String(triggersFired(f, ['cross-host-wake'])['cross-host-wake']?.evidence), /@critic \(host2\) woke @researcher \(host1\)/);
  assert.ok(triggersFired(f, ['remote-attachment-read'])['remote-attachment-read']);
  assert.deepEqual(of(f, 'attachment-laptop-path'), []);
  f.streams.push({ handle: 'critic', events: call('k4', 'Read', { file_path: '/Users/user/uat-runs/x/data/blobs/ab/cd' }) });
  assert.equal(of(f, 'attachment-laptop-path')[0]?.title, 'An agent on a host was given a path on this computer');
  // In a run without hosts, they can’t tell.
  assert.equal(triggersFired(facts({ hosts: undefined }), ['cross-host-wake'])['cross-host-wake'], null);
});

test('#120 setup and listeners: a host just added with no Install, and a new listener of the run’s own during a turn', () => {
  const f = facts();
  f.hosts.setup = [
    { label: 'host1', installOffered: false, card: 'a.example.com Not connected yet' },
    { label: 'host2', installOffered: true },
  ];
  assert.deepEqual(
    of(f, 'host-install-offered').map((x) => x.key),
    ['host1'],
  );
  f.hosts.listeners.samples = [
    { where: 'host1', at: 1, added: ['127.0.0.1:27452 (pid 1555)'], run: [] },
    { where: 'local', at: 2, added: ['127.0.0.1:5000 (pid 300)'], run: ['127.0.0.1:5000 (pid 300)'] },
    { where: 'host2', at: 3, error: 'Couldn’t read the listeners on the host: sh: 1: ss: not found' },
  ];
  assert.deepEqual(
    of(f, 'host-listeners').map((x) => x.title),
    ['A new TCP listener during a turn, on this computer', 'The listeners couldn’t be read during a turn, on host2'],
  );
});

test('#120 the history keeps a session’s remote turn, so a turn that ran on a host is known after the next one', () => {
  const e = keepEvent(9, 'session', {
    id: 's1',
    state: 'think',
    remoteTurn: { hostId: 'ho_1', turn: HT.r1, rtTurn: T.r1, state: 'running', offset: 4, replies: [1] },
  });
  assert.deepEqual(e?.data.remoteTurn, { hostId: 'ho_1', turn: HT.r1, rtTurn: T.r1, state: 'running' });
  assert.equal(Object.hasOwn(keepEvent(10, 'session', { id: 's1', state: 'idle' })?.data ?? {}, 'remoteTurn'), false);
});
