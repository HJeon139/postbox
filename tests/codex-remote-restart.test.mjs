// The Codex adapter on a remote host after a Postbox restart (#120, L4c): the turn already there is replayed from its
// logs and rebuilt (createCodexRebuild), and only the approvals nobody answered get one. Its fixtures are in
// tests/codex-remote-fixture.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter, createCodexRebuild } from '../server/adapters/codex.mjs';
import { approval, context, FOLDER, forbidden, leftOnHost, linkTo, RECORDED, ready, SENT_BEFORE, sent, until } from './codex-remote-fixture.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';

test('#120: after a Postbox restart, a remote Codex turn is replayed and rebuilt: IDs, and only the approval nobody answered', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  // Recorded lines up to the message, then two approvals: the first answered before the restart, the second not.
  leftOnHost(d, 'tr1', {
    out: [...RECORDED.slice(0, 7), approval(0, 'cmd_a', 'ls'), approval(1, 'cmd_b', 'rm -rf build')],
    inLines: [...SENT_BEFORE, '{"id":0,"result":{"decision":"accept"}}'],
  });
  // in.jsonl’s lines come after all of out.jsonl’s, as they may from the real daemon, whose two readers race.
  const link = linkTo(d, { delayIn: 40 });
  await ready(link);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  const { ctx, calls, abort } = context(link, { attach: { turn: 'tr1' }, answers: [{ allow: false }] });
  const turn = adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx);
  await until(() => d.turns.get('tr1').writes.length === 1, 'the answer to the open approval');
  assert.equal(sent(d, 'start').length, 0, 'an attach starts nothing');
  assert.deepEqual(
    sent(d, 'read').map((m) => [m.from, m.log ?? 'out']),
    [
      [0, 'in'],
      [0, 'out'],
    ],
  );
  assert.equal(calls.text, 'Hello from Codex.', 'the reply is rebuilt from the replay');
  assert.deepEqual(
    calls.asked.map((a) => a.detail),
    [`rm -rf build\n\nWorking directory: ${FOLDER}`],
    'only the unanswered approval asks again',
  );
  assert.deepEqual(JSON.parse(d.turns.get('tr1').writes[0]), { id: 1, result: { decision: 'decline' } }, 'answered through the held stdin');
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1');
  abort.abort();
  await turn;
  assert.deepEqual(
    JSON.parse(d.turns.get('tr1').writes[1]),
    { id: 4, method: 'turn/interrupt', params: { threadId: 'thr_postbox_1', turnId: 'turn_postbox_1' } },
    'the next request ID follows the ones in.jsonl shows',
  );
  assert.deepEqual(d.stops, ['tr1']);
  assert.deepEqual(f.calls, []);
});

test('#120: a rebuilt Codex turn waits for caught-up on both logs: an in.jsonl answer that comes late still means no second answer', async () => {
  // The daemon’s in.jsonl reader is slow: out.jsonl is replayed and caught up, and in.jsonl’s answer comes well after.
  const d = createFakeDaemon({ autoEnd: false, lines: [], holdCaughtUp: ['in'] });
  leftOnHost(d, 'tr3', { out: [...RECORDED.slice(0, 7), approval(0, 'cmd_a', 'ls')], inLines: SENT_BEFORE });
  const link = linkTo(d);
  await ready(link);
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list });
  const { ctx, calls, abort } = context(link, { attach: { turn: 'tr3' }, answers: [{ allow: true }] });
  const turn = adapter.deliver({}, { kind: 'user', text: 'not sent again' }, ctx);
  await until(() => d.sent.some((m) => m.type === 'caught-up' && m.turn === 'tr3' && m.log === 'out'), 'out.jsonl caught up');
  // Longer than any quiet time a heuristic would wait.
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(calls.asked, [], 'nothing is asked before in.jsonl has caught up');
  // The answer Postbox gave before the restart, then in.jsonl’s caught-up.
  d.appendIn('tr3', '{"id":0,"result":{"decision":"accept"}}');
  d.caughtUp('tr3', 'in');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls.asked, [], 'answered before the restart: not asked again');
  assert.deepEqual(d.turns.get('tr3').writes, [], 'and no second answer');
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1', 'the rebuild finished');
  abort.abort();
  await turn;
  assert.deepEqual(JSON.parse(d.turns.get('tr3').writes[0]).method, 'turn/interrupt');
});

test('#120: a remote Codex turn that can’t be rebuilt after a restart ends as interrupted, and is stopped on the host', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  // Postbox restarted after initialize, before the thread or the turn existed: the message never reached Codex.
  leftOnHost(d, 'tr2', { out: RECORDED.slice(0, 1), inLines: SENT_BEFORE.slice(0, 2) });
  const link = linkTo(d);
  await ready(link);
  const adapter = new CodexAdapter();
  // An attach reuses the host turn it names, so it needs no ctx.remote.turn.
  const { ctx } = context(link, { attach: { turn: 'tr2' }, remote: { turn: undefined } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x' }, ctx), (e) => e.code === 'interrupted' && /can’t be picked up/.test(e.message));
  assert.deepEqual(d.stops, ['tr2']);
  // A turn the host doesn’t list any more is interrupted too.
  const { ctx: gone } = context(link, { attach: { turn: 'tr-missing' } });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'x' }, gone), (e) => e.code === 'interrupted');
});

test('#120: the rebuild settles a request by in.jsonl, serverRequest/resolved, its item completing, or the turn completing', () => {
  const r = createCodexRebuild();
  for (const l of RECORDED.slice(0, 4)) r.out(JSON.parse(l));
  for (const id of [0, 1, 2, 3]) r.out(JSON.parse(approval(id, `cmd_${id}`, 'true')));
  r.out({ id: 'elicit-1', method: 'mcpServer/elicitation/request', params: { serverName: 'github' } });
  r.in({ id: 0, result: { decision: 'accept' } });
  r.out({ method: 'serverRequest/resolved', params: { threadId: 'thr_postbox_1', requestId: 1 } });
  r.out({ method: 'item/completed', params: { item: { id: 'cmd_2', type: 'commandExecution', status: 'declined' } } });
  for (const l of SENT_BEFORE) r.in(JSON.parse(l));
  r.in({ id: 9, method: 'turn/interrupt', params: {} });
  assert.equal(r.threadId, 'thr_postbox_1');
  assert.equal(r.turnId, 'turn_postbox_1');
  assert.equal(r.nextRequestId(), 10);
  assert.deepEqual(
    r.open().map((m) => m.id),
    [3, 'elicit-1'],
  );
  assert.equal(r.answered('1'), false, 'a string ID isn’t the integer one');
  r.out(JSON.parse(RECORDED.at(-1)));
  assert.equal(r.completed, true);
  assert.deepEqual(r.open(), []);
});
