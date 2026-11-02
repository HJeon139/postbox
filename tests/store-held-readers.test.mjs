// Readers in the server that act on what the same turn or session emitted a moment before, while a commit holds those
// emits (#601; the sweep in the PR body, class A). Each spec makes its emit while a commit is in flight, so it is held,
// unseen by a read of the visible items only, then checks the reader, then releases. The same scripted Claude Code
// agent and held store as the Stop specs (stop-reply-fixture.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { recordDenial } from '../server/permission-cards.mjs';
import { heldStore, setup, sleep, until } from './stop-reply-fixture.mjs';

/** A room on a store whose next commit is held in its fsync; returns once emits are held, with `done` to release. */
async function heldRoom(step = async () => {}) {
  const h = await heldStore();
  const env = await setup(step, h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const done = async () => {
    h.release();
    await commit;
    await h.store.flush();
  };
  return { ...env, done, close: () => h.store.close() };
}
const progress = (se, turnId) => ({
  kind: 'block',
  valid: true,
  sessionId: se.id,
  turnId,
  block: { id: 'work', type: 'progress', version: 1, fallback: 'Work', steps: [{ id: 's1', label: 'Read the papers', state: 'running' }] },
});

test('stallSteps: a progress block held at the turn’s end has its running step stalled, and the agent is told', async () => {
  const env = await heldRoom();
  const it = env.rt.addItem(env.t.id, progress(env.se, 'turn_a'));
  const problems = env.rt.stallSteps({ threadId: env.t.id }, env.rt.s.sessions[env.se.id]);
  assert.deepEqual(
    problems.map((p) => p.code),
    ['steps-left-running'],
  );
  await env.done();
  assert.equal(env.store.item(env.t.id, it.id).block.steps[0].state, 'stalled');
  await env.close();
});

test('the lint block check: a choice block held when the turn ends counts as shown, so options in the reply aren’t flagged', async () => {
  const env = await heldRoom();
  env.rt.addItem(env.t.id, {
    kind: 'block',
    valid: true,
    sessionId: env.se.id,
    turnId: 'turn_b',
    block: { id: 'pick', type: 'choice', version: 1, fallback: 'Pick', options: [{ id: 'a', label: 'A' }] },
  });
  const turn = { id: 'turn_b', threadId: env.t.id, said: 'Two ways to go:\n\n1. The corpus\n2. The claims\n\nWhich first?' };
  const codes = env.rt.checkTurn(turn, env.rt.s.sessions[env.se.id]).map((p) => p.code);
  assert.ok(!codes.includes('options-in-prose'), `the held choice is what the turn showed: ${codes}`);
  await env.done();
  await env.close();
});

test('recordDenial: the same refused call twice while its first card is held gives one card', async () => {
  const env = await heldRoom();
  const turn = { id: 'turn_c', threadId: env.t.id, sessionId: env.se.id, said: '' };
  const d = { toolUseId: 'tu_1', tool: 'Bash', input: { command: 'rm -rf build' }, reason: 'Not allowed' };
  recordDenial(env.rt, turn, d);
  recordDenial(env.rt, turn, d);
  await env.done();
  assert.equal(env.store.items(env.t.id).filter((i) => i.kind === 'denial').length, 1);
  await env.close();
});

test('a topic’s reply count includes the reply just added while a commit is held', async () => {
  const h = await heldStore();
  const env = await setup(async () => {}, h.store);
  const root = env.rt.addItem(env.t.id, { kind: 'user', text: 'Start here' });
  const { threadId } = env.rt.startTopic(env.t.id, root.id);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  env.rt.addItem(threadId, { kind: 'user', text: 'The first reply' });
  h.release();
  await commit;
  await h.store.flush();
  assert.equal(h.store.item(env.t.id, root.id).replies, 1);
  await h.store.close();
});

test('update_block finds a block the same turn showed while a commit is held', async () => {
  const results = {};
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await heldRoom(async (c) => {
    await proceed;
    const block = { id: 'steps', type: 'progress', version: 1, fallback: 'Steps', steps: [{ id: 'a', label: 'A', state: 'running' }] };
    results.shown = await c.tools.show_block({ block });
    results.updated = await c.tools.update_block({ block: { ...block, steps: [{ id: 'a', label: 'A', state: 'done' }] } });
  });
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  go();
  await until(() => 'updated' in results, 'the update');
  assert.equal(results.updated?.ok, true, `update_block found the held block: ${JSON.stringify(results.updated)}`);
  env.rt.stop(env.se.id);
  await env.done();
  await env.close();
});

test('endWork: a turn whose only reply is a block shown while a commit is held gets its work line on that block (#601 reader 2)', async () => {
  const h = await heldStore();
  let go = () => {};
  const proceed = new Promise((r) => {
    go = () => r(undefined);
  });
  const env = await setup(async (c) => {
    await proceed;
    c.tools.show_block({ block: { id: 'pick', type: 'choice', version: 1, fallback: 'Pick one', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] } });
  }, h.store);
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await until(() => env.rt.turns.size === 1, 'the turn to start');
  const turnId = env.rt.turns.get(env.se.id).id;
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  go();
  await sleep(20);
  env.rt.turns.get(env.se.id)?.abort.abort(); // the turn ends while the commit is still held
  await until(() => !env.rt.turns.size, 'the turn to end');
  await sleep(50); // endWork runs after the ledger’s end of the turn
  h.release();
  await commit;
  await h.store.flush();
  const block = h.store.items(env.t.id).find((i) => i.kind === 'block' && i.turnId === turnId);
  assert.deepEqual({ work: block?.work, workTurn: block?.workTurn }, { work: '1 block', workTurn: turnId });
  await h.store.close();
});

test('a ! command run while a commit is held keeps its output: the flush finds its held item', async () => {
  const env = await heldRoom();
  // A fake child, as tests/commands.test.mjs makes: unit specs start no processes.
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  env.rt.spawnShell = () => child;
  await env.rt.runShellCommand(env.t.id, 'echo held-output');
  child.stdout.write('held-output\n');
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => child.emit('close', 0, null));
  const cmd = () => env.store.pending.items(env.t.id).find((i) => i.kind === 'command');
  // It flushes its output and ends while the commit is still held: the read that sees it is the held view.
  await until(() => cmd()?.status === 'done', 'the command to end, seen through what is held');
  await env.done();
  assert.match(cmd().text, /held-output/, JSON.stringify(cmd()));
  await env.close();
});
