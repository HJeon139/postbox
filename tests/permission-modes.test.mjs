// Ask me and Accept edits are gone: the harness judges in Auto, or the agent runs everything
// (server/permission-modes.mjs). A persona stored with a retired mode runs Auto.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedMode, runsAs } from '../server/permission-modes.mjs';
import { Runtime } from '../server/runtime.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

test('a persona stored as Accept edits runs Auto from its next turn, and is stored as Auto once Postbox loads', async () => {
  const { rt, store, t, a, adapter } = setup();
  store.emit('persona', { ...store.state.personas[a.id], permissionMode: 'acceptEdits' });
  const seen = [];
  adapter.next.push(async (c) => seen.push(c.persona.permissionMode));
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.deepEqual(seen, ['auto'], 'its next turn runs Auto');
  const again = new Runtime({ store, adapters: rt.adapters, corpus: rt.corpus, config: rt.config });
  assert.equal(store.state.personas[a.id].permissionMode, 'auto', 'stored as Auto once loaded');
  assert.equal(again.persona(a.id).permissionMode, 'auto');
  assert.throws(
    () => rt.updatePersona(a.id, { permissionMode: 'yolo' }),
    (e) => e.status === 422,
  );
});

test('a mode sent is stored as one of the two: a retired one as Auto, and anything else refused', () => {
  assert.deepEqual(['auto', 'bypass', 'ask', 'acceptEdits'].map(checkedMode), ['auto', 'bypass', 'auto', 'auto']);
  assert.throws(
    () => checkedMode('yolo'),
    (e) => e.status === 422 && /Permissions are one of auto, bypass/.test(e.message),
  );
  assert.deepEqual([undefined, 'ask', 'bypass'].map(runsAs), ['auto', 'auto', 'bypass']);
});
