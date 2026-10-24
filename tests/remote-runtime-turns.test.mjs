// Remote hosts in the runtime (#120; tests/remote-runtime.test.mjs says how): `!` staying on this computer for an agent
// on a host (#67), what a remote turn may post, and archive and delete stopping a conversation’s turns.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, tick, until } from './remote-runtime-helpers.mjs';

// ── `!` stays on this computer (G6) ─────────────────────────────────────────────────

test('#120 G6: ! for an agent on a host runs in the project’s folder here, never a host path, and says so once', async () => {
  const { rt, store, children } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  // Its own folder names a path on the host: `!` never runs there.
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', folder: '/home/user/app', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/work/project', host: 'host.example.com' });
  await rt.runShellCommand(t.id, 'ls');
  assert.equal(children[0].opts.cwd, '/work/project');
  children[0].stdout.write('a\n');
  children[0].stdout.write('b\n');
  children[0].exit(0);
  await tick();
  const it = store.items(t.id).find((i) => i.kind === 'command');
  assert.deepEqual([it.cwd, it.notOn, it.status], ['/work/project', 'host.example.com', 'done']);
  assert.equal(it.text, '! commands run on this computer, not on host.example.com.\na\nb\n');

  // No folder for the project here: the workspace of its own the agent would have on this computer.
  store.emit('project', { ...store.state.projects.p1, folder: '' });
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/work/space/far', host: 'host.example.com' });
  // An agent on this computer: its own folder, and no note.
  rt.updatePersona(far.id, { remote: null });
  assert.deepEqual(await rt.commandFolder(t.id), { folder: '/home/user/app', host: null });
});

test('#120: a remote turn is told it may post to the conversation only where the laptop’s would: the person’s, in a topic thread', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far'), 'the conversation’s turn');
  assert.equal(adapter.bring.get('far'), false, 'in the conversation, bring_to_conversation isn’t offered');
  rt.stop(rt.sessionsIn(t.id)[0].id);
  await until(() => adapter.log.includes('stopped:far') && rt.turns.size === 0 && rt.exiting.size === 0, 'stopped');
  const topic = rt.createThread({ projectId: 'p1', title: 'Topic', personaIds: [], kind: 'topic', parentId: t.id });
  rt.sendMessage(topic.id, { text: '@far go on here' });
  await until(() => adapter.log.filter((x) => x === 'start:far').length === 2, 'the topic thread’s turn');
  assert.equal(adapter.bring.get('far'), true, 'in a topic thread, at the person’s message, it is (ctx.remote.bring)');
  rt.stop(rt.sessionsIn(t.id)[0].id);
});

// ── Archive and delete stop a conversation’s turns ─────────────────────────────────

test('#120: archiving a conversation stops its turns on a host, the ones in its topic threads too', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const fork = rt.createPersona({ handle: 'fork', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'Side', personaIds: [fork.id], kind: 'topic', parentId: t.id });
  rt.sendMessage(t.id, { text: 'go' });
  rt.sendMessage(side.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far') && adapter.log.includes('start:fork'), 'two turns');
  // One session per agent per conversation (#228): @fork answers the topic thread from its session in the conversation,
  // so archiving the conversation’s sessions archives it, and stops both turns.
  for (const se of rt.sessionsIn(t.id)) rt.archive(se.id);
  await until(() => adapter.log.includes('stopped:far') && adapter.log.includes('stopped:fork'), 'both stopped');
  assert.equal(rt.turns.size, 0);
  assert.equal(rt.s.threads[t.id].archived, true);
});

test('#120: deleting a conversation stops its turns on a host, its topic threads’ too', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const fork = rt.createPersona({ handle: 'fork', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  const side = rt.createThread({ projectId: 'p1', title: 'Side', personaIds: [fork.id], kind: 'topic', parentId: t.id });
  rt.sendMessage(t.id, { text: 'go' });
  rt.sendMessage(side.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far') && adapter.log.includes('start:fork'), 'two turns');
  rt.deleteThread(t.id);
  await until(() => adapter.log.includes('stopped:far') && adapter.log.includes('stopped:fork'), 'both stopped');
  assert.equal(rt.turns.size, 0);
  rt.undoDeleteThread(t.id);
});
