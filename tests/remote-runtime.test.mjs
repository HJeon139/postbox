// Remote hosts in the runtime and the API (#120, the plan’s L5): where a persona runs, and removing a host (its turns
// stop first). `!` and a conversation’s turns, each host’s status and waking, and the routes are in
// tests/remote-runtime-*.test.mjs; what they share is tests/remote-runtime-helpers.mjs. The host manager is a fake with
// the interface server/remote’s has; no process, socket or ssh runs.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { failure as sshFailure } from '../server/remote/ssh.mjs';
import { Store } from '../server/store.mjs';
import { refused, setup, until } from './remote-runtime-helpers.mjs';

// ── Where a persona runs ─────────────────────────────────────────────────────────────

test('#120: a persona runs on a host only with a backend that can, and only on a host Postbox knows', () => {
  const { rt } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const p = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  assert.deepEqual(p.remote, { hostId: h.id });
  assert.equal(rt.createPersona({ handle: 'near', backend: 'claude-code' }).remote, null, 'this computer by default');

  assert.match(
    refused(() => rt.createPersona({ handle: 'mocked', backend: 'mock', remote: { hostId: h.id } })),
    /“mock” runs only on this computer, so this agent can’t run on host\.example\.com\. Backends here that can run on a host: claude-code\./,
  );
  assert.match(
    refused(() => rt.createPersona({ handle: 'lost', backend: 'claude-code', remote: { hostId: 'ho_none' } })),
    /That host doesn’t exist/,
  );
  // hostId must be the host’s own, not something on Object’s prototype.
  refused(() => rt.createPersona({ handle: 'proto', backend: 'claude-code', remote: { hostId: 'constructor' } }));
  for (const bad of ['host.example.com', [h.id], { hostId: h.id, folder: '/srv' }, { host: h.id }])
    assert.match(
      refused(() => rt.createPersona({ handle: 'odd', backend: 'claude-code', remote: bad })),
      /null, for this computer, or \{ hostId \}|doesn’t exist/,
    );
  assert.equal(rt.personaByHandle('odd'), undefined, 'a refused persona isn’t stored');

  // Moving it: there and back, and a backend that can’t follow it there.
  const near = rt.personaByHandle('near');
  assert.deepEqual(rt.updatePersona(near.id, { remote: { hostId: h.id } }).remote, { hostId: h.id });
  assert.deepEqual(rt.updatePersona(near.id, { description: 'Builds things' }).remote, { hostId: h.id }, 'other edits keep it');
  assert.match(
    refused(() => rt.updatePersona(near.id, { backend: 'mock' })),
    /“mock” runs only on this computer/,
  );
  assert.equal(rt.persona(near.id).backend, 'claude-code');
  const both = rt.updatePersona(near.id, { backend: 'mock', remote: null });
  assert.deepEqual([both.backend, both.remote], ['mock', null]);
});

test('#120: where a persona runs survives a store reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'postbox-remote-runtime-'));
  try {
    const store = await new Store(dir).load();
    const { rt } = setup({ store });
    const h = rt.addHost({ name: 'host.example.com' });
    const p = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
    const q = rt.createPersona({ handle: 'near', backend: 'claude-code' });
    await store.close();
    const again = await new Store(dir).load();
    assert.deepEqual(again.state.personas[p.id].remote, { hostId: h.id });
    assert.equal(again.state.personas[q.id].remote, null);
    await again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#120: a persona isn’t moved between this computer and a host in the middle of a turn', async () => {
  const { rt, adapter } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const p = rt.createPersona({ handle: 'dev', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:dev'), 'the turn');
  assert.match(
    refused(() => rt.updatePersona(p.id, { remote: { hostId: h.id } }), 409),
    /@dev is in the middle of a turn/,
  );
  // The same placement isn’t a move.
  assert.equal(rt.updatePersona(p.id, { remote: null, description: 'x' }).description, 'x');
  for (const se of rt.sessionsIn(t.id)) rt.stop(se.id, { silent: true });
  await until(() => !rt.exiting.size, 'the stop');
  assert.deepEqual(rt.updatePersona(p.id, { remote: { hostId: h.id } }).remote, { hostId: h.id });
});

// ── Removing a host (G10) ───────────────────────────────────────────────────────────

test('#120 G10: removing a host stops its turns first, then forgets its link and token, then removes it', async () => {
  const { rt, adapter, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const other = rt.addHost({ name: 'other.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const elsewhere = rt.createPersona({ handle: 'elsewhere', backend: 'claude-code', remote: { hostId: other.id } });
  const near = rt.createPersona({ handle: 'near', backend: 'claude-code' });
  const t = rt.createThread({ projectId: 'p1', title: 'Room', personaIds: [far.id, elsewhere.id, near.id] });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  for (const handle of ['far', 'elsewhere', 'near']) rt.sendMessage(t.id, { text: `@${handle} go` });
  await until(() => adapter.log.filter((l) => l.startsWith('start:')).length === 3, 'three turns');

  let atForget = null;
  hosts.onForget = () => {
    atForget = { log: [...adapter.log], exiting: rt.exiting.size, hostKnown: Boolean(rt.s.hosts[h.id]) };
  };
  const r = await rt.removeHost(h.id);
  assert.deepEqual(r, { ok: true, stopped: 1 });
  assert.deepEqual(atForget, { log: [...adapter.log.slice(0, 3), 'stopped:far'], exiting: 0, hostKnown: true }, 'stopped and ended before the forget');
  assert.deepEqual(
    hosts.calls.filter((c) => c[0] === 'forget'),
    [['forget', h.id]],
  );
  assert.equal(rt.s.hosts[h.id], undefined);
  assert.deepEqual(rt.s.projects.p1.hostFolders, {});
  const running = rt
    .sessionsIn(t.id)
    .filter((se) => rt.turns.has(se.id))
    .map((se) => se.handle);
  assert.deepEqual(running.sort(), ['elsewhere', 'near'], 'turns on this computer and other hosts run on');
  for (const se of rt.sessionsIn(t.id)) rt.stop(se.id, { silent: true });
});

test('#120 G10: a stopped turn that never ends holds a host’s removal only for its wait', async () => {
  const { rt, adapter, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  adapter.hang.add('far');
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far'), 'the turn');
  assert.deepEqual(await rt.removeHost(h.id, { waitMs: 20 }), { ok: true, stopped: 1 });
  assert.deepEqual(hosts.calls, [
    ['removeFromHost', h.id],
    ['forget', h.id],
  ]);
  assert.equal(rt.s.hosts[h.id], undefined);
});

test('#120: removing a host removes Postbox from it once its turns stop, and forgets its token only after the daemon says removed', async () => {
  const { rt, adapter, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [far.id] });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  rt.sendMessage(t.id, { text: 'go' });
  await until(() => adapter.log.includes('start:far'), 'the turn');
  let atRemove = null;
  hosts.onRemove = () => {
    atRemove = { stopped: adapter.log.includes('stopped:far'), forgotten: hosts.calls.some((c) => c[0] === 'forget'), hostKnown: Boolean(rt.s.hosts[h.id]) };
  };
  assert.deepEqual(await rt.removeHost(h.id), { ok: true, stopped: 1 });
  assert.deepEqual(atRemove, { stopped: true, forgotten: false, hostKnown: true }, 'removed there after its turns stopped, before the token went');
  assert.deepEqual(hosts.calls, [
    ['removeFromHost', h.id],
    ['forget', h.id],
  ]);
  assert.equal(rt.s.hosts[h.id], undefined);
});

test('#120: a removal the host doesn’t confirm keeps the host, its folders and its token, and says why and what to do next', async () => {
  const { rt, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  rt.setProjectHostFolder('p1', h.id, '/home/user/app');
  hosts.removeError = sshFailure('unreachable', 'host.example.com');
  const e = await rt.removeHost(h.id).catch((x) => x);
  assert.equal(e.status, 409, e.message);
  assert.match(
    e.message,
    /^Postbox couldn’t reach host\.example\.com\. .*Postbox keeps host\.example\.com and its token here until it can remove itself there\.$/,
  );
  assert.equal(e.next, hosts.removeError.next, 'the manager’s next step');
  assert.equal(e.code, 'unreachable');
  assert.deepEqual(hosts.calls, [['removeFromHost', h.id]], 'its token wasn’t forgotten');
  assert.ok(rt.s.hosts[h.id]);
  assert.deepEqual(rt.s.projects.p1.hostFolders, { [h.id]: '/home/user/app' });
  // Once the host confirms, it goes.
  hosts.removeError = null;
  assert.deepEqual(await rt.removeHost(h.id), { ok: true, stopped: 0 });
  assert.equal(rt.s.hosts[h.id], undefined);
});

test('#120: a host this computer has no token for, with no turns there, is removed here: Postbox can’t reach anything of its own there', async () => {
  const { rt, hosts } = setup();
  const h = rt.addHost({ name: 'host.example.com' });
  hosts.removeError = Object.assign(sshFailure('not-installed', 'host.example.com'), { code: 'not-installed' });
  assert.deepEqual(await rt.removeHost(h.id), { ok: true, stopped: 0 });
  assert.deepEqual(hosts.calls, [
    ['removeFromHost', h.id],
    ['forget', h.id],
  ]);
  assert.equal(rt.s.hosts[h.id], undefined);
});
