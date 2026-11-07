// #874, the same class in requests: a request about an agent whose backend isn’t registered in this Postbox (its
// permissions panel, a `!` command’s folder, the files it names for an app, Always allow on a card) is refused with a
// 422 and the reason, not the registry’s 500, and changes nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './side-threads-fixture.mjs';

const REASON = '@beta’s Claude Code isn’t available on this computer. Install it and restart Postbox, or change this agent’s backend.';
const refused = { status: 422, message: REASON };

/** @beta runs on Claude Code, which this Postbox didn’t register (createPersona refuses it, so it’s emitted). */
function unregistered() {
  const f = setup();
  f.store.emit('persona', { ...f.rt.persona(f.b.id), backend: 'claude-code' });
  return f;
}

test('#874 a ! command where the agent that replies has an unregistered backend is refused with the reason, and nothing runs', async () => {
  const f = unregistered();
  f.rt.putThread({ ...f.store.state.threads[f.t.id], lastSpeaker: f.beta.id });
  const before = f.store.items(f.t.id).length;
  await assert.rejects(f.rt.runShellCommand(f.t.id, 'ls'), refused);
  assert.equal(f.store.items(f.t.id).length, before, 'no command item');
});

test('#874 the folders of an agent with an unregistered backend are refused with the reason', async () => {
  const f = unregistered();
  await assert.rejects(f.rt.agentFolders(f.beta.id), refused);
});

test('#874 the permissions panel of an agent with an unregistered backend is refused with the reason', async () => {
  const f = unregistered();
  await assert.rejects(f.rt.permissionsView({ sessionId: f.beta.id }), refused);
  await assert.rejects(f.rt.permissionsView({ personaId: f.b.id }), refused);
});

test('#874 Always allow on a permission card of an agent with an unregistered backend is refused with the reason, and saves nothing', async () => {
  const f = unregistered();
  const it = { id: 'it_1', sessionId: f.beta.id, always: { saves: 'Bash(ls)', lines: [{ rule: 'Bash(ls)' }] } };
  const before = f.store.items(f.t.id).length;
  await assert.rejects(f.rt.allowAlways(f.t.id, it, '@beta to list files'), refused);
  assert.equal(f.store.items(f.t.id).length, before, 'no “Always allowed” line');
});

test('#874 Always on a refusal card of an agent with an unregistered backend is refused with the reason, and the card stays open', async () => {
  const f = unregistered();
  const card = f.rt.addItem(f.t.id, {
    kind: 'denial',
    sessionId: f.beta.id,
    handle: 'beta',
    turnId: 'turn_last',
    summary: 'list files',
    rules: { once: 'Bash(ls)', always: 'Bash(ls)', alwaysWords: 'ls' },
    status: 'open',
  });
  const before = f.store.items(f.t.id).length;
  await assert.rejects(f.rt.resolveDenial(f.t.id, card.id, 'always'), refused);
  assert.equal(f.store.item(f.t.id, card.id).status, 'open');
  assert.equal(f.store.items(f.t.id).length, before);
});
