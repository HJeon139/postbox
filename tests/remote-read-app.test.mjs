// An agent on a host reads another agent's app code through Postbox (#516's S1, #417): the host passes read_message's
// arguments through as they are (server/remote/turns-tools.mjs), `version` among them, and the laptop's read_message
// answers. The turn's snapshot doesn't carry app code: an app item's snapshot text says its code needs Postbox
// connected, so a read with Postbox away says so instead of giving the head line alone. Over tests/fake-daemon.mjs,
// as tests/remote-turns.test.mjs runs; nothing here starts a process or opens a connection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMessage as readOffline } from '../server/remote/host/broker-reading.mjs';
import { READING } from '../shared/limits.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';

/** A rig whose conversation has @maker's two-version app "lab", 50,000 characters at v1. */
function withApp() {
  const r = rig();
  const p = r.rt.createPersona({ handle: 'maker', backend: 'claude-code' });
  const maker = r.rt.ensureSession(r.t.id, p.id);
  const tools = r.rt.toolsFor(maker.id);
  const v1 = Array.from({ length: 5000 }, (_, i) => `<b>${String(i).padStart(5, '0')}</b>`).join('\n');
  assert.notEqual(tools.show_app({ id: 'lab', title: 'Lab', code: v1 }).ok, false);
  assert.notEqual(tools.update_app({ id: 'lab', code: '<p>two</p>' }).ok, false);
  return { r, v1 };
}

test('#516 S1: an agent on a host reads another agent’s app code through Postbox, with version passed through', async () => {
  const { r, v1 } = withApp();
  const turn = await running(r, '@coder hi');
  const id = r.d.tool(turn, 'read_message', { id: 'lab', version: 1, from: READING.part });
  await until(() => r.d.replies.some((x) => x.id === id), 'the reply');
  const reply = r.d.replies.find((x) => x.id === id);
  assert.equal(reply.ok, true, reply.text);
  assert.match(reply.text, /@maker/);
  assert.match(reply.text, /v1/);
  assert.ok(reply.text.includes(v1.slice(READING.part, READING.part + 200)), 'v1’s code from character 40,000');
  assert.ok(!reply.text.includes('<p>two</p>'), 'not v2’s');
  r.d.end(turn);
  await settled(r);
});

test('#516 S1: the snapshot carries no app code, and its app item says the code needs Postbox connected', async () => {
  const { r, v1 } = withApp();
  const turn = await running(r, '@coder hi');
  const snap = r.d.received.find((m) => m.type === 'snapshot' && m.turn === turn);
  const app = snap.threads[0].items.find((i) => i.blockId === 'lab');
  assert.ok(app, JSON.stringify(snap.threads[0].items.map((i) => i.line)));
  assert.ok(!app.text.includes(v1.slice(0, 50)) && !app.text.includes('<p>two</p>'), 'no code in the snapshot');
  // Read with Postbox away, as the host's broker does from the snapshot.
  const offline = readOffline(snap, { id: 'lab' });
  assert.equal(offline.ok, true);
  assert.match(offline.text, /App lab, v2/);
  assert.match(offline.text, /code[^.]*Postbox[^.]*connected/i);
  r.d.end(turn);
  await settled(r);
});
