// A remote turn through the whole pipeline, with only ssh replaced (#120, V1). A real Runtime and the real host manager
// (server/remote/hosts.mjs), with the real Claude Code adapter, links and remote process; their ssh `spawn` runs ssh’s
// last argument with /bin/sh -c and a temp folder as HOME, as sshd hands the remote command to the login shell. So
// Postbox installs its host code there (rt.installHost: the install script and the token step through the launcher),
// and each session runs the installed `host attach`, which starts the real `host serve`; the daemon starts the real
// runner, which starts the harness, which starts the real shim. The harness is tests/fixtures/remote/claude-standin.mjs,
// the host’s claudePath: a stand-in that speaks MCP to the shim and replays recorded Claude Code lines (its header says
// which). Nothing listens on TCP or touches the network, the real home folder or ~/.postbox-remote.
//
// What it checks, each as its own test: a turn that streams, shows a block, asks and is allowed, then ends Done; an ssh
// drop mid-turn; the daemon killed mid-turn; Postbox restarted mid-turn; Stop; a prompt that expires; and a turn whose
// runner is killed, which is Interrupted and resumes on its own. “No line applied twice” is checked exactly: the adapter
// records every line it applies (POSTBOX_CLAUDE_RECORD), and that must be the stand-in’s stdout, line for line. Every
// process a test starts is gone when it ends (on Linux, also every process /proc finds with the test’s marker). It runs
// in a container with no init too: a killed daemon nobody reaps stays a zombie, which proc.mjs’s sameProcess counts as
// gone, so the next attach starts a new daemon.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../server/store.mjs';
import { gone, until } from './host.mjs';
import { alive, appliedRuns, daemonPid, LINUX, marked, onMachines, RUN, replyOf, standins, TEST } from './remote-pipeline-machines.mjs';
import {
  allow,
  appliedOnce,
  atGate,
  blocks,
  cards,
  heard,
  open,
  postbox,
  replies,
  replyText,
  runnerOf,
  sentOf,
  settled,
  started,
} from './remote-pipeline-postbox.mjs';

// ── The tests ───────────────────────────────────────────────────────────────────────

test('#120 pipeline: a remote Claude Code turn streams in, shows its block, asks, is allowed from the runtime, and ends Done', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await started(m, p, 'Write hello to a file. standin:allow');
    assert.equal(s.run.start.resumeInterrupted, null);
    // The shim was started exactly as --mcp-config said: the host’s node, the installed shim.mjs and the turn.
    assert.deepEqual([s.run.start.server.type, s.run.start.server.command, s.run.start.server.args], ['stdio', process.execPath, [m.paths.shim, s.turn]]);
    const mcp = await heard(m, s.run.pid, 'mcp');
    assert.equal(mcp.name, 'postbox');
    assert.ok(mcp.tools.includes('show_block') && mcp.tools.includes('permission_prompt'), 'the shim lists Postbox’s tools');
    // The block came through the shim, the daemon and the link, and shows once.
    await until(() => blocks(p).length === 1, 'the block');
    // The prompt is the laptop’s card, waiting; the shim’s progress kept the call alive meanwhile.
    await until(() => p.se().remoteTurn.state === 'waiting', 'Waiting on you');
    await heard(m, s.run.pid, 'progress');
    const decision = await allow(m, p, s.run.pid);
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: (await heard(m, s.run.pid, 'decision')).asked });
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    const reply = replies(p).filter((i) => i.text);
    assert.deepEqual(
      reply.map((i) => i.status),
      ['done'],
    );
    assert.equal(replyText(p), replyOf('permission-allow'));
    assert.equal(blocks(p).length, 1, 'the block once');
    assert.equal(cards(p).length, 1);
    assert.match(cards(p)[0].status, /^allowed/);
    appliedOnce(m, 'one run');
    // The turn’s processes on the host have gone with it.
    const shim = (await heard(m, s.run.pid, 'shim')).pid;
    await until(() => [s.run.pid, s.runner, shim].every(gone), 'the turn’s processes to exit');
    assert.equal(sentOf(m, 'start').length, 1);
    assert.deepEqual(p.f.calls, [], 'nothing ran on this computer');
  }),
);

test('#120 pipeline: an ssh drop mid-turn leaves the turn running on the host; the link reconnects and reads on, no line applied twice', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const first = m.sessions.filter((x) => x.attach).at(-1);
    assert.ok(first);
    // The transport dies: the ssh session’s whole group, SIGKILL. The next session waits out a longer backoff, so the
    // turn runs a while with nobody connected.
    m.delay = 1500;
    const written = standins(m).at(-1)?.out.length ?? 0;
    process.kill(-(/** @type {number} */ (first.child.pid)), 'SIGKILL');
    await until(() => p.rt.hostStatus(p.host.id).state !== 'connected', 'the link to see the drop');
    await until(() => (standins(m).at(-1)?.out.length ?? 0) > written + 200, 'the turn to write on with nobody connected');
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the runner and the harness are still running');
    await until(() => p.rt.hostStatus(p.host.id).state === 'connected', 'the link to reconnect', 20_000);
    m.delay = 50;
    const second = m.sessions.filter((x) => x.attach).at(-1);
    assert.notEqual(second, first, 'a new session');
    // It reads on from where it had got to, not from the start.
    const read = await until(() => second?.sent.find((x) => x.type === 'read' && x.turn === s.turn && !x.log), 'the read on the new session');
    const acked = Math.max(0, ...first.sent.filter((x) => x.type === 'ack' && x.turn === s.turn).map((x) => x.upTo));
    assert.ok(read.from > 0 && read.from >= acked, `read from ${read.from}, past the last ack (${acked})`);
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-allow'));
    appliedOnce(m, 'across the drop');
    assert.equal(sentOf(m, 'start').length, 1, 'started once');
    assert.equal(blocks(p).length, 1);
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: the daemon killed mid-turn; the runner survives, the next attach starts a new daemon, and the turn goes on', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const old = daemonPid(m);
    assert.ok(old && alive(old), 'a daemon serves');
    m.pids.set(old, 'the first daemon');
    const sessions = m.sessions.length;
    process.kill(old, 'SIGKILL');
    await until(() => gone(old), 'the daemon to die');
    // The daemon was detached, so it’s an orphan for PID 1 to reap. Where PID 1 doesn’t (a container with no init), it
    // stays a zombie, which daemon.pid’s owner check counts as gone, so a new daemon still starts.
    // Its attach relay ends with it, and the link’s next session starts `host serve` again.
    await until(() => m.sessions.length > sessions && p.rt.hostStatus(p.host.id).state === 'connected', 'a new session', 20_000);
    const fresh = await until(() => {
      const pid = daemonPid(m);
      return pid !== old && pid && alive(pid) ? pid : null;
    }, 'a new daemon');
    assert.notEqual(fresh, old);
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the runner and the harness lived through it');
    const welcome = await until(() => m.sessions.at(-1)?.got.find((x) => x.type === 'welcome'), 'the new daemon’s welcome');
    assert.equal(welcome.turns.find((t) => t.turn === s.turn)?.state, 'running', 'it found the turn running');
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-allow'));
    appliedOnce(m, 'across the daemon’s restart');
    assert.equal(sentOf(m, 'start').length, 1);
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: Postbox restarts mid-turn; the new one attaches to the turn on the host and replays it, with nothing twice', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const store = new Store(null);
    const first = await postbox(m, postboxes, store);
    const s = await atGate(m, first);
    await until(() => blocks(first).length === 1 && replyText(first).length === 0, 'the block, before any reply text');
    // Postbox shuts down: the remote turn goes on on the host, and its ssh sessions end.
    await first.done();
    await until(() => m.sessions.every((x) => x.child.exitCode !== null || x.child.signalCode !== null), 'its ssh sessions to end');
    assert.equal(store.state.sessions[first.se().id].remoteTurn.turn, s.turn, 'the host turn is kept with the session');
    assert.ok(alive(s.runner) && alive(s.run.pid), 'the turn runs on');
    const before = m.sessions.length;

    // A new Postbox on the same store, starting up as server/index.mjs does.
    const second = await postbox(m, postboxes, store);
    for (const se of Object.values(store.state.sessions))
      if (['think', 'gen', 'tool', 'stopping'].includes(se.state)) second.rt.updateSession(se.id, { state: 'idle', currentStep: 'Interrupted by a restart' });
    for (const [threadId, list] of Object.entries(store.state.items))
      for (const it of list) if (it.status === 'streaming') second.rt.patchItem(threadId, it.id, { status: 'stopped' });
    second.rt.expireStalePermissions();
    second.rt.restoreRemoteTurns();
    second.rt.watchHosts();
    const read = await until(
      () =>
        m.sessions
          .slice(before)
          .flatMap((x) => x.sent)
          .find((x) => x.type === 'read' && x.turn === s.turn && !x.log),
      'the attach’s read',
    );
    assert.equal(read.from, 0, 'replayed from the start');
    open(m);
    await heard(m, s.run.pid, 'end');
    await settled(second);
    assert.equal(second.se().remoteTurn.state, 'done');
    // The reply is the one the stream makes in one go: what showed before the restart was replaced, not added to.
    assert.equal(replyText(second), replyOf('permission-allow'));
    assert.deepEqual(
      replies(second)
        .filter((i) => i.text)
        .map((i) => i.status),
      ['done'],
    );
    assert.equal(blocks(second).length, 1, 'the block once');
    assert.equal(cards(second).length, 1, 'the card once');
    assert.equal(sentOf(m, 'start').length, 1, 'attached, not started again');
    const runs = appliedRuns(m);
    assert.equal(runs.length, 2, 'one run before the restart, one after');
    appliedOnce(m, 'the replay');
    assert.ok(runs.at(-1)?.startsWith(/** @type {string} */ (runs[0])), 'what was applied before the restart is where the replay began');
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: Stop sends SIGINT to the host’s stand-in, which ends its turn, and no process of the turn is left', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await atGate(m, p);
    const shim = (await heard(m, s.run.pid, 'shim')).pid;
    assert.ok([s.runner, s.run.pid, shim].every(alive));
    assert.equal(p.rt.stop(p.se().id), true);
    await heard(m, s.run.pid, 'sigint');
    await settled(p);
    await until(() => [s.runner, s.run.pid, shim].every(gone), 'the runner, the stand-in and the shim to exit', 15_000);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(sentOf(m, 'stop').filter((x) => x.turn === s.turn).length >= 1, true, 'the stop went to the daemon');
    // Its last line is the result Claude Code writes when SIGINT ends a turn.
    const last = JSON.parse(standins(m).at(-1)?.out.trim().split('\n').at(-1) ?? '{}');
    assert.deepEqual([last.type, last.subtype], ['result', 'error_during_execution']);
    assert.ok(
      replies(p).some((i) => i.status === 'stopped'),
      'the reply says it was stopped',
    );
    assert.deepEqual(p.f.calls, [], 'nothing was signaled on this computer');
  }),
);

test('#120 pipeline: a prompt nobody answers expires on the host; its card ends Expired and the stand-in is denied', TEST, () =>
  onMachines({ timings: { waitMax: 2000 } }, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    const s = await started(m, p, 'Delete the test file. standin:deny');
    await until(() => cards(p).some((i) => i.status === 'open'), 'the permission card');
    const { decision } = await heard(m, s.run.pid, 'decision');
    assert.equal(decision.behavior, 'deny');
    assert.match(decision.message, /^Nobody answered this permission request in Postbox within 2 seconds, so it was denied\./);
    await until(() => cards(p)[0]?.status === 'expired', 'the card to end Expired');
    assert.equal(cards(p)[0].noAnswer, true, 'it says nobody answered in time');
    await heard(m, s.run.pid, 'end');
    await settled(p);
    assert.equal(p.se().remoteTurn.state, 'done');
    assert.equal(replyText(p), replyOf('permission-deny'));
    assert.equal(cards(p)[0].status, 'expired', 'still Expired once the turn ended');
    appliedOnce(m, 'one run');
    await until(() => [s.run.pid, s.runner].every(gone), 'the turn’s processes to exit');
  }),
);

test('#120 pipeline: SIGKILL to the runner’s group shows Interrupted, and the turn resumes on its own with CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1', TEST, () =>
  onMachines({}, async (m, postboxes) => {
    const p = await postbox(m, postboxes);
    /** @type {string[]} */
    const states = [];
    const off = p.store.subscribe(() => {
      const st = p.t && p.rt.sessionsIn(p.t.id)[0]?.remoteTurn?.state;
      if (st && st !== states.at(-1)) states.push(st);
    });
    try {
      const s = await atGate(m, p);
      const shim = (await heard(m, s.run.pid, 'shim')).pid;
      process.kill(-s.runner, 'SIGKILL');
      await until(() => [s.runner, s.run.pid, shim].every(gone), 'the turn’s group to die');
      // No exit.json: the daemon finds the runner gone, and the runtime says Interrupted, then resumes on its own.
      const again = await until(() => standins(m)[1], 'the resumed turn to start on the host', 30_000);
      assert.ok(states.includes('interrupted'), `Interrupted came before the resume (${states.join(', ')})`);
      assert.ok(
        replies(p).some((i) => /^Interrupted on host\.example\.com: /.test(i.error ?? '')),
        'the cut-off reply says Interrupted',
      );
      assert.equal(again.start.resumeInterrupted, '1', 'the resumed turn goes on with the cut-off one');
      assert.ok(again.start.argv.includes('--resume'), 'it resumes the same Claude Code session');
      const resumed = await runnerOf(m, p);
      assert.notEqual(resumed.turn, s.turn, 'a new host turn');
      await heard(m, again.pid, 'end');
      await settled(p);
      assert.equal(p.se().remoteTurn.state, 'done');
      assert.ok(replyText(p).endsWith(replyOf('model-effort')), 'the resumed turn’s reply');
      appliedOnce(m, 'the resumed run');
      assert.equal(sentOf(m, 'start').length, 2, 'the first turn and the resume');
      await until(() => [again.pid, resumed.runner].every(gone), 'the resumed turn’s processes to exit');
    } finally {
      off();
    }
  }),
);

test('#120 pipeline: on Linux, no process with this file’s marker outlives the tests above', {
  skip: LINUX ? false : 'needs /proc to find processes by their environment; on macOS each test checks the PIDs it saw instead',
  timeout: 15_000,
}, async () => {
  await until(() => !marked(RUN).length, 'every marked process to be gone', 5000).catch(() => {});
  assert.deepEqual(marked(RUN), []);
});
