// The room checks that compare the turns’ streams with the state leave out the streams of an erased conversation’s
// sessions (#729). Deleting a conversation removes its sessions and their Work ledger, but its turns’ stream files
// stay, tied to a session only by the Claude Code session id in their init. No recorded run holds a delete with a
// mismatch the check missed, so the rooms are built inline, in the shapes tests/uat-checks.test.mjs uses.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolCalls } from '../server/room-checks-tools.mjs';
import { erasedStreams, keptStreams } from '../server/room-checks-work.mjs';
import { runChecks } from '../tools/uat/checks.mjs';

const LIVE = 'c0ffee00-live';
const GONE = 'dead0000-gone';

const init = (id) => ({ type: 'system', subtype: 'init', session_id: id });
const call = (id, name, input, extra = {}) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok', ...extra }] } },
];
const refusal = (id) => ({ type: 'result', permission_denials: [{ tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }] });

/** A room whose live conversation has @researcher in Claude Code session LIVE; the erased one’s session is gone. */
const room = (streams, over = {}) => ({
  state: {
    threads: { t1: { id: 't1', title: 'Deletes and Undo', kind: 'thread', members: ['s1'] } },
    items: { t1: [] },
    sessions: { s1: { id: 's1', handle: 'researcher', state: 'idle', backendState: { claudeSessionId: LIVE } } },
    work: { t1: [] },
    personas: {},
    apps: {},
    glossary: {},
  },
  threads: ['t1'],
  startPersonas: [],
  streams,
  transcripts: [],
  console: [],
  apps: {},
  probes: { fullScreen: [], attachments: [] },
  samples: [],
  ui: {},
  userMcpServers: [],
  userRulesMarker: null,
  ...over,
});
const turn = (id, events, started = 20) => ({ handle: 'researcher', started, ended: started + 5, events: id === undefined ? events : [init(id), ...events] });
const found = (f, check) => runChecks(f).filter((x) => x.check === check);
const recorded = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
/** A room whose live session ran the recorded stream: it holds the Claude Code session id the stream’s init names. */
function recordedRoom(name) {
  const events = recorded(name);
  const f = room([{ handle: 'researcher', events }]);
  f.state.sessions.s1.backendState.claudeSessionId = events.find((e) => e.subtype === 'init')?.session_id;
  return f;
}

test('refusals in a recorded stream with no cards in the conversation reproduce #65', () => {
  const out = found(recordedRoom('denials'), 'refusal-without-card');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].evidence, /4 refused, 0 cards/);
  // A call the person declined on a permission card isn’t a refusal.
  assert.deepEqual(found(recordedRoom('permission-deny'), 'refusal-without-card'), []);
});

test('keptStreams keeps a stream a session holds, and one with no session id, and drops an erased one', () => {
  const live = turn(LIVE, []);
  const gone = turn(GONE, []);
  const bare = turn(undefined, []);
  const noId = turn(undefined, [{ type: 'system', subtype: 'init' }]);
  assert.deepEqual(keptStreams(room([live, gone, bare, noId])), [live, bare, noId]);
});

test('work-commands-match-stream leaves out an erased conversation’s commands, and still finds a live one’s', () => {
  const erased = turn(GONE, call('b_gone', 'Bash', { command: 'sleep 1' }));
  assert.deepEqual(found(room([erased]), 'work-commands-match-stream'), []);
  const live = turn(LIVE, call('b_live', 'Bash', { command: 'pytest' }));
  const out = found(room([erased, live]), 'work-commands-match-stream');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /^1 of 1 Bash calls .*`pytest`/);
});

test('a stream with no init, or an init with no session id, is kept: it can’t be shown erased', () => {
  for (const s of [
    turn(undefined, call('b1', 'Bash', { command: 'sleep 1' })),
    turn(undefined, [{ type: 'system', subtype: 'init' }, ...call('b1', 'Bash', { command: 'sleep 1' })]),
  ])
    assert.equal(found(room([s]), 'work-commands-match-stream').length, 1);
});

test('work-files-match-stream leaves out an erased conversation’s edits, and still finds a live one’s', () => {
  const erased = turn(GONE, call('e_gone', 'Write', { file_path: '/w/gone.md' }));
  assert.deepEqual(found(room([erased]), 'work-files-match-stream'), []);
  const out = found(room([erased, turn(LIVE, call('e_live', 'Write', { file_path: '/w/live.md' }))]), 'work-files-match-stream');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /\/w\/live\.md\.$/);
});

test('refusal-without-card leaves out an erased conversation’s refusals, whose cards went with it', () => {
  assert.deepEqual(found(room([turn(GONE, [refusal('r_gone')])]), 'refusal-without-card'), []);
  assert.equal(found(room([turn(GONE, [refusal('r_gone')]), turn(LIVE, [refusal('r_live')])]), 'refusal-without-card').length, 1);
});

test('shell-off-silent leaves out an erased conversation’s refused commands, whose refused steps went with it', () => {
  const refused = (id) => turn(id, call(`b_${id}`, 'Bash', { command: 'pytest' }, { is_error: true, content: 'Permission denied' }));
  const probes = { fullScreen: [], attachments: [], panels: [{ handle: 'researcher', set: { shell: false }, at: 10 }] };
  assert.deepEqual(found(room([refused(GONE)], { probes }), 'shell-off-silent'), []);
  assert.equal(found(room([refused(GONE), refused(LIVE)], { probes }), 'shell-off-silent').length, 1);
});

test('a limit: a live session whose Claude Code session id was reset loses its older turns from these checks', () => {
  // Claude Code no longer had the session (or a fork’s branch point), so Postbox cleared the id and started over
  // (server/adapters/claude-code.mjs). The session keeps no earlier ids, so its turns before the reset read as erased.
  const before = turn('0ld00000-reset', call('b_old', 'Bash', { command: 'pytest' }), 5);
  assert.deepEqual(keptStreams(room([before])), []);
  assert.deepEqual(found(room([before]), 'work-commands-match-stream'), []);
});

test('work-files-match-stream on a host leaves out an erased conversation’s edits, and still finds a live one’s', () => {
  const hosts = { placement: { researcher: 'h1' } };
  const erased = turn(GONE, call('e_gone', 'Write', { file_path: '/h/gone.md' }));
  assert.deepEqual(found(room([erased], { hosts }), 'work-files-match-stream'), []);
  const out = found(room([erased, turn(LIVE, call('e_live', 'Write', { file_path: '/h/live.md' }))], { hosts }), 'work-files-match-stream');
  assert.deepEqual(
    out.map((x) => x.key),
    ['remote-missing'],
  );
  assert.match(out[0].evidence, /: \/h\/live\.md\.$/);
});

/** The room with @critic removed from it: its session is gone, and its refusal card stays, marked deletedAgent. */
function roomWithRemovedAgent(streams) {
  const f = room(streams);
  f.state.items.t1 = [{ id: 'd1', kind: 'denial', handle: 'critic', sessionId: 's2', toolUseId: 'r_removed', deletedAgent: true }];
  return f;
}
const removedTurn = (events) => ({ handle: 'critic', started: 10, ended: 15, events: [init('0ff00000-removed'), ...events] });

test('refusal-without-card still reports a live agent’s uncarded refusal when a removed agent’s card stays', () => {
  const out = found(roomWithRemovedAgent([removedTurn([refusal('r_removed')]), turn(LIVE, [refusal('r_live')])]), 'refusal-without-card');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].evidence, /^1 refused, 0 cards\. @researcher: Bash/);
});

test('an agent removed from a kept conversation: its refusal with its card, and its commands, are left out today', () => {
  // Its session is gone, so its streams read as erased, though its card and its Work stay in the conversation, which
  // keeps its Work (#729). Neither side is judged: a command of its missing from Work goes unreported.
  assert.deepEqual(found(roomWithRemovedAgent([removedTurn([refusal('r_removed')])]), 'refusal-without-card'), []);
  assert.deepEqual(found(roomWithRemovedAgent([removedTurn(call('b_removed', 'Bash', { command: 'pytest' }))]), 'work-commands-match-stream'), []);
});

test('a state with a session that ran a turn but has no Claude Code session id keeps every stream: it’s legacy', () => {
  // Saved before sessions kept their ids: it can’t tell an erased stream from a live one.
  const f = room([turn(LIVE, call('b_live', 'Bash', { command: 'pytest' }))]);
  f.state.sessions.s1.backendState = {};
  f.state.sessions.s1.finishedAt = 1000;
  assert.equal(keptStreams(f).length, 1);
  assert.deepEqual(erasedStreams(f), []);
  assert.equal(found(f, 'work-commands-match-stream').length, 1);
});

test('only sessions that never ran a turn left: a removed session’s stream is erased, not kept (UAT 2026-11-04)', () => {
  // The run’s shape: the deleted conversation’s session ran Bash calls, then was purged; the sessions left had
  // never run a turn, so none holds an id. That isn’t a legacy state: the stream is erased.
  const gone = turn(GONE, [...call('b1', 'Bash', { command: 'sleep 1' }), ...call('b2', 'Bash', { command: 'ls' })]);
  const f = room([gone]);
  f.state.sessions = {
    s1: { id: 's1', handle: 'researcher', state: 'idle', finishedAt: null, backendState: {} },
    s2: { id: 's2', handle: 'critic', state: 'idle', finishedAt: null },
  };
  assert.deepEqual(erasedStreams(f), [gone]);
  assert.deepEqual(keptStreams(f), []);
  assert.deepEqual(found(f, 'work-commands-match-stream'), []);
});

test('every conversation deleted: no session left, and every stream with a session id is erased', () => {
  const gone = turn(GONE, call('b1', 'Bash', { command: 'sleep 1' }));
  const bare = turn(undefined, []);
  const f = room([gone, bare]);
  f.state.sessions = {};
  assert.deepEqual(erasedStreams(f), [gone]);
  assert.deepEqual(keptStreams(f), [bare]);
  assert.deepEqual(found(f, 'work-commands-match-stream'), []);
});

/** A Bash call Claude Code never ran: Postbox stopped the turn, and Claude Code answered it as rejected. */
const rejectedCall = (id, command) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The user doesn’t want to proceed with this tool use.' }] },
    tool_use_result: 'User rejected tool use',
    tool_result_meta: [{ id, non_execution_kind: 'user-rejected' }],
  },
];

test('work-commands-match-stream leaves out a Bash call Claude Code never ran, and counts one that exited 1', () => {
  assert.deepEqual(found(room([turn(LIVE, rejectedCall('b_rej', 'sleep 30'))]), 'work-commands-match-stream'), []);
  const failed = turn(LIVE, call('b_fail', 'Bash', { command: 'false' }, { is_error: true, content: 'Exit code 1' }));
  const out = found(room([failed]), 'work-commands-match-stream');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].evidence, /^1 of 1 Bash calls .*`false`/);
  // Both together: only the one that ran is counted.
  const both = found(room([turn(LIVE, [...rejectedCall('b_rej', 'sleep 30'), ...failed.events.slice(1)])]), 'work-commands-match-stream');
  assert.match(both[0].evidence, /^1 of 1 Bash calls /);
});

test('toolCalls marks a call Claude Code answered without running it as rejected, by any non-execution kind', () => {
  const calls = toolCalls([...rejectedCall('b1', 'x'), ...call('b2', 'Bash', { command: 'y' }, { is_error: true })]);
  assert.deepEqual(
    calls.map((c) => [c.id, c.rejected]),
    [
      ['b1', true],
      ['b2', false],
    ],
  );
  const other = rejectedCall('b3', 'z');
  other[1].tool_result_meta = [{ id: 'b3', non_execution_kind: 'interrupted' }];
  assert.equal(toolCalls(other)[0].rejected, true);
});

test('a session deleted but still in its Undo window keeps its streams: its Work is still in the state', () => {
  const DELETING = 'de1e7000-undo';
  const f = room([turn(DELETING, call('b_undo', 'Bash', { command: 'pytest' }))]);
  f.state.sessions.s2 = { id: 's2', handle: 'researcher', state: 'idle', deleting: 1000, backendState: { claudeSessionId: DELETING } };
  const out = found(f, 'work-commands-match-stream');
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /`pytest`/);
});

test('a purged topic thread’s streams are left out today, though its commands stay in its conversation’s Work', () => {
  // Purging a topic thread removes its sessions; Work is kept by conversation, so the root keeps the topic’s entries.
  const topic = turn('70p1c000-purged', call('b_topic', 'Bash', { command: 'pytest' }));
  const f = room([topic]);
  assert.deepEqual(keptStreams(f), []);
  assert.deepEqual(found(f, 'work-commands-match-stream'), []);
  f.state.work.t1 = [{ kind: 'command', toolUseId: 'b_topic' }];
  assert.deepEqual(found(f, 'work-commands-match-stream'), []);
});

test('refusal-without-card weighs each agent’s refusals against its own cards, among several agents', () => {
  // @researcher has two refusals and two cards, @critic one and one, @scribe one and none: only @scribe is short,
  // though the room holds more cards (3) than @scribe has refusals.
  const f = room([
    { ...turn(LIVE, [refusal('r_a'), refusal('r_b')]) },
    { ...turn('c0ffee01-critic', [refusal('r_c')]), handle: 'critic' },
    { ...turn('c0ffee02-scribe', [refusal('r_s')]), handle: 'scribe' },
  ]);
  f.state.sessions.s2 = { id: 's2', handle: 'critic', state: 'idle', backendState: { claudeSessionId: 'c0ffee01-critic' } };
  f.state.sessions.s3 = { id: 's3', handle: 'scribe', state: 'idle', backendState: { claudeSessionId: 'c0ffee02-scribe' } };
  const card = (id, handle) => ({ id: `d_${id}`, kind: 'denial', handle, toolUseId: id });
  f.state.items.t1 = [card('r_a', 'researcher'), card('r_b', 'researcher'), card('r_c', 'critic')];
  const out = found(f, 'refusal-without-card');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].evidence, '1 refused, 0 cards. @scribe: Bash rm -rf build.');
});

test('work-commands-match-stream leaves out a Bash call the person refused, which never ran', () => {
  const refused = [...call('b_den', 'Bash', { command: 'rm -rf build' }, { is_error: true, content: 'Permission denied' }), refusal('b_den')];
  assert.deepEqual(found(room([turn(LIVE, refused)]), 'work-commands-match-stream'), []);
});
