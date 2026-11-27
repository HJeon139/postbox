// A remote turn’s writes to its session’s remoteTurn while a commit is held (#623, designs/508/601-held-view.md, “a
// read that decides a write reads pending”). A write held behind a commit is pending, not published, so a write of
// remoteTurn built or decided from the published session drops what the held one left: a kept reply, a stop’s entry,
// the turn’s state. Each test holds a commit, drives a real remote turn over the fake daemon
// (tests/remote-turns-held-fixture.mjs), then releases it and reads what was kept. Resumes are
// tests/remote-turns-held-resume.test.mjs’s.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askStop, stopConfirmed } from '../server/remote/turns-stops.mjs';
import { heldRig, remoteTurn } from './remote-turns-held-fixture.mjs';
import { running, settled, starts, until } from './remote-turns-helpers.mjs';

/** The replies the link sent for one call. @param {any} r @param {string} id */
const repliesTo = (r, id) => r.link.sent.filter((m) => m.type === 'reply' && m.id === id);

test('two calls’ replies recorded behind one held commit are both kept, so a repeat of the first isn’t applied again (#623, #439)', async () => {
  const r = await heldRig();
  const turn = await running(r);
  const mine = r.store.items(r.t.id).find((i) => i.kind === 'user');
  const release = await r.hold();
  const first = r.d.tool(turn, 'react', { id: mine.id, emoji: '✅' });
  await until(() => r.d.replies.length === 1, 'the first reply');
  r.d.tool(turn, 'define_term', { term: 'held', definition: 'behind a commit' });
  await until(() => r.d.replies.length === 2, 'the second reply');
  await release();
  // The daemon sends the first again after a hello: its kept reply answers it, and react isn’t applied a second time,
  // which would take the reaction back.
  r.link.hear({ type: 'tool', turn, id: first, name: 'react', args: { id: mine.id, emoji: '✅' } });
  await until(() => repliesTo(r, first).length === 2, 'the repeat’s reply');
  const reacted = (r.store.item(r.t.id, mine.id).reactions ?? []).filter((x) => x.emoji === '✅');
  assert.equal(reacted.length, 1, 'still reacted: the repeat wasn’t applied again');
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('a call repeated while its reply is held behind a commit gets the kept reply, and isn’t applied again (#623, #439)', async () => {
  const r = await heldRig();
  const turn = await running(r);
  const release = await r.hold();
  const args = { in_minutes: 15, note: 'Check the run.' };
  const id = r.d.tool(turn, 'schedule_wake', args);
  await until(() => r.d.replies.length === 1, 'the reply');
  r.link.hear({ type: 'tool', turn, id, name: 'schedule_wake', args });
  await until(() => repliesTo(r, id).length === 2, 'the repeat’s reply');
  await release();
  assert.equal(repliesTo(r, id)[1].text, repliesTo(r, id)[0].text, 'the same answer');
  assert.equal(Object.keys(r.store.state.schedules ?? {}).length, 1, 'one wake scheduled, not a second for the repeat');
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('a stop’s entry asked behind a held commit is kept when the turn’s next reply is recorded (#623, askStop)', async () => {
  const r = await heldRig();
  const turn = await running(r);
  const release = await r.hold();
  askStop(r.rt.remote, r.se().id, r.host.id, 'host-turn-old', { send: false });
  r.d.tool(turn, 'define_term', { term: 'held', definition: 'behind a commit' });
  await until(() => r.d.replies.length === 1, 'the reply');
  await release();
  assert.deepEqual(
    (remoteTurn(r).stopping ?? []).map((x) => x.turn),
    ['host-turn-old'],
    'the stop is kept on the session, so a restart asks for it again',
  );
  r.rt.remote.stopping.delete('host-turn-old');
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('stops asked behind one held commit are each kept, and confirming one keeps the others (#623, askStop, dropStop)', async () => {
  const r = await heldRig();
  const turn = await running(r);
  const release = await r.hold();
  for (const t of ['host-turn-a', 'host-turn-b', 'host-turn-c']) askStop(r.rt.remote, r.se().id, r.host.id, t, { send: false });
  stopConfirmed(r.rt.remote, 'host-turn-a');
  await release();
  assert.deepEqual(
    (remoteTurn(r).stopping ?? []).map((x) => x.turn),
    ['host-turn-b', 'host-turn-c'],
    'the stops not yet confirmed are kept, so a restart asks for them again',
  );
  for (const t of ['host-turn-b', 'host-turn-c']) r.rt.remote.stopping.delete(t);
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('a stop asked behind a held commit and then confirmed started there keeps its entry, now confirmed (#623, saveStop)', async () => {
  const r = await heldRig();
  const turn = await running(r);
  const release = await r.hold();
  askStop(r.rt.remote, r.se().id, r.host.id, 'host-turn-old', { send: false, unconfirmed: true });
  r.link.hear({ type: 'started', turn: 'host-turn-old' });
  await release();
  assert.deepEqual(
    remoteTurn(r).stopping,
    [{ turn: 'host-turn-old', hostId: r.host.id, at: remoteTurn(r).stopping[0]?.at }],
    'kept, and no longer unconfirmed, so a welcome that doesn’t list it ends it',
  );
  r.rt.remote.stopping.delete('host-turn-old');
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('a turn that starts and ends behind one held commit isn’t left running, and keeps where its stream was read (#623, ended)', async () => {
  const r = await heldRig();
  const release = await r.hold();
  const turn = await running(r);
  r.d.end(turn);
  await settled(r);
  await release();
  assert.equal(remoteTurn(r)?.state, 'done', 'the turn ended on the host, so its session doesn’t say it runs there');
  assert.equal(remoteTurn(r).offset, r.d.turns.get(turn).out.at(-1).next, 'the offset read up to is kept (offsetAt)');
  await r.close();
});

test('a turn started behind a held commit and stopped by the person isn’t left running (#623, stopped)', async () => {
  const r = await heldRig();
  const release = await r.hold();
  const turn = await running(r);
  r.rt.stop(r.se().id, { by: 'you' });
  await settled(r);
  await until(() => !r.rt.remote.stopping.has(turn), 'the host to confirm the stop');
  await release();
  assert.equal(remoteTurn(r)?.state, 'done', 'stopped and confirmed, so its session doesn’t say it runs there');
  assert.deepEqual(remoteTurn(r).stopping ?? [], [], 'no stop is left to ask again');
  await r.close();
});

test('a prompt from a turn started behind a held commit shows the session waiting on the person (#623, setWaiting)', async () => {
  const r = await heldRig();
  const release = await r.hold();
  const turn = await running(r);
  r.d.prompt(turn);
  await until(() => [...r.rt.permissionWaits.values()].some((w) => w.sessionId === r.se().id), 'the card');
  await release();
  assert.equal(remoteTurn(r).state, 'waiting', 'its card waits on the person');
  r.d.end(turn);
  await settled(r);
  await r.close();
});

test('a relative edit by a turn started behind a held commit is recorded in the turn’s folder on its host (#623, hostFolder)', async () => {
  const r = await heldRig();
  const release = await r.hold();
  const turn = await running(r);
  const { folder } = starts(r.d).at(-1);
  // The agent edits a file by a path relative to its folder on the host, and the edit works.
  const id = 'toolu_held_edit';
  const input = { file_path: 'notes.txt', old_string: 'a', new_string: 'b' };
  r.d.append(turn, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input }] } }));
  r.d.append(turn, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Edited.' }] } }));
  const edits = () => (r.store.pending.work(r.t.id) ?? []).filter((e) => e.kind === 'edit');
  await until(() => edits().length === 1, 'the edit step');
  await release();
  assert.equal(edits()[0].path, `${folder}/notes.txt`, 'the file is the one in the turn’s folder on the host');
  r.d.end(turn);
  await settled(r);
  await r.close();
});
