// #909: a turn on a host for an agent whose backend isn’t registered after a restart (#874) is Interrupted once,
// with the reason, and waits for the person: the host coming back again neither attaches it nor resumes it, and a
// turn stopped with Sign-in needed isn’t resumed when its check passes. Once the backend is registered again, a turn
// the host listed still waits for the person, since it may still be running there and a resume would run beside it
// (#872); one the host had no record of, or listed as ended, resumes as any other does.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as arrange from './arrange.mjs';
import { restarted, rig, settled, sleep, starts, startUp, until } from './remote-turns-helpers.mjs';

const WHY =
  'Claude Code isn’t available to Postbox on this computer, so it can’t follow the turn on the host. Install it here and restart Postbox, or change this agent’s backend';
/** #874’s reason for a turn that didn’t start, as the person’s Resume gives it. */
const REASON = '@coder’s turn didn’t start: Claude Code isn’t available on this computer. Install it and restart Postbox, or change this agent’s backend.';

const failed = (r) => r.store.items(r.t.id).filter((i) => i.kind === 'agent' && i.status === 'failed');
/** The host’s connection comes back, as the host manager says so. */
const back = (r) => r.hosts.emit('status', r.host.id, { state: 'connected' });
/** Whatever the host coming back started has ended, and the microtasks it queued have run. */
const quiet = async (r) => {
  await settled(r);
  await sleep(20);
};

/**
 * A Postbox restarted during @coder’s turn on the host, with no backend registered for it now (#874), after the
 * startup’s attempt to attach it. `registered` registers its backends again.
 * @param {{ signIn?: any, saved?: object, welcome?: 'running' | 'ended' | 'unkilled' | 'missing', moved?: boolean }} [o] `saved` patches the
 * session’s saved remoteTurn before the startup; `moved` puts the agent on this computer since
 */
async function unregisteredRestart({
  signIn = null,
  saved = null,
  welcome = /** @type {'running' | 'ended' | 'unkilled' | 'missing'} */ ('running'),
  moved = false,
} = {}) {
  const { store, d } = restarted({ welcome });
  const r = rig({ store, d, signIn });
  if (saved) r.rt.updateSession(r.se().id, { remoteTurn: { ...r.se().remoteTurn, ...saved } });
  if (moved) r.store.emit('persona', { ...r.rt.persona(r.se().personaId), remote: null });
  const registered = arrange.withoutAdapters(r.rt);
  startUp(r);
  if (!saved) await until(() => failed(r).length > 0, 'a failed item');
  await quiet(r);
  return { r, d, registered };
}

test('#909 a host turn whose backend isn’t registered is Interrupted with the reason, not attached', async () => {
  const { r, d } = await unregisteredRestart();
  const items = failed(r);
  assert.equal(items.length, 1);
  assert.equal(items[0].error, `Interrupted on host.example.com: ${WHY}.`);
  assert.equal(items[0].remote?.state, 'interrupted');
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.ok(!r.rt.remote.restoring.has('host-turn-1'), 'no longer waiting to be attached');
  assert.ok(!r.rt.remote.early.has('host-turn-1'), 'nothing kept for an attach');
  assert.equal(r.hosts.calls.release.length, r.hosts.calls.need.length, 'every need released');
  assert.equal(starts(d).length, 0, 'nothing started on the host');
});

test('#909 the host coming back again adds nothing for a host turn whose backend isn’t registered', async () => {
  const { r } = await unregisteredRestart();
  const count = r.store.items(r.t.id).length;
  back(r);
  await quiet(r);
  back(r);
  await quiet(r);
  assert.equal(r.store.items(r.t.id).length, count, 'no item per reconnect');
  assert.equal(r.se().remoteTurn.autoResumes ?? 0, 0);
});

test('#909 an Interrupted turn whose backend isn’t registered isn’t resumed on its own', async () => {
  const { r, d } = await unregisteredRestart();
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.ok(r.se().remoteTurn.resume, 'it waits to resume');
  back(r);
  await quiet(r);
  assert.equal(r.se().remoteTurn.autoResumes ?? 0, 0, 'no resume tried');
  assert.equal(failed(r).length, 1, 'no failed reply from a resume');
  assert.equal(r.rt.turns.size, 0);
  assert.equal(starts(d).length, 0);
});

test('#909 after the backend is installed and Postbox restarted, a turn the host listed running waits for the person, and their Resume starts once', async () => {
  const { r, d } = await unregisteredRestart();
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.equal(r.se().remoteTurn.resume?.unkilled, true, 'it waits for the person');
  // Postbox restarts with the backend registered: a new runtime on the saved state, and a new connection.
  r.rt.remote.close();
  d.drop();
  d.connect();
  const again = rig({ store: r.store, d });
  startUp(again);
  await quiet(again);
  assert.equal(again.se().remoteTurn.resume?.unkilled, true, 'the flag is read back from the saved state');
  back(again);
  await quiet(again);
  assert.equal(starts(d).length, 0, 'not resumed beside a turn that may still run there (#872)');
  assert.equal(again.se().remoteTurn.autoResumes ?? 0, 0);
  assert.deepEqual(again.rt.resumeRemote(again.se().id), { ok: true });
  await until(() => starts(d).length === 1, 'the person’s resume');
  d.end(starts(d)[0].turn);
  await quiet(again);
  back(again);
  await quiet(again);
  assert.equal(starts(d).length, 1, 'one start');
});

test('#909 a turn the host lists interrupted, its process there unkilled (#872), waits for the person once the backend is back', async () => {
  const { r, d, registered } = await unregisteredRestart({ welcome: 'unkilled' });
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.equal(r.se().remoteTurn.resume?.unkilled, true, 'its process may still run there');
  registered();
  back(r);
  await quiet(r);
  assert.equal(starts(d).length, 0, 'not resumed beside a process that may still run');
});

test('#909 a turn the host listed as ended doesn’t wait for the person, and resumes once the backend is registered again', async () => {
  const { r, d, registered } = await unregisteredRestart({ welcome: 'ended' });
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.ok(!r.se().remoteTurn.resume?.unkilled, 'nothing runs there to wait on');
  registered();
  back(r);
  await until(() => starts(d).length === 1, 'the resume');
  assert.equal(r.se().remoteTurn.autoResumes, 1);
  d.end(starts(d)[0].turn);
  await settled(r);
});

test('#909 once the backend is registered again, a turn the host had no record of resumes when the host is back', async () => {
  const { r, d, registered } = await unregisteredRestart({ welcome: 'missing' });
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  assert.ok(!r.se().remoteTurn.resume?.unkilled, 'nothing runs there to wait on');
  registered();
  back(r);
  await until(() => starts(d).length === 1, 'the resume');
  assert.equal(starts(d)[0].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, '1');
  assert.equal(r.se().remoteTurn.autoResumes, 1);
  d.end(starts(d)[0].turn);
  await settled(r);
});

test('#909 Resume for an Interrupted turn whose backend is still missing gives one failed reply, and the host coming back adds none', async () => {
  const { r, d } = await unregisteredRestart();
  assert.equal(r.se().remoteTurn.state, 'interrupted');
  const before = failed(r).length;
  assert.deepEqual(r.rt.resumeRemote(r.se().id), { ok: true });
  await quiet(r);
  assert.equal(failed(r).length, before + 1);
  assert.equal(failed(r).at(-1).error, REASON);
  back(r);
  await quiet(r);
  assert.equal(failed(r).length, before + 1, 'nothing more on the host coming back');
  assert.equal(starts(d).length, 0);
});

test('#909 a Sign-in needed turn whose backend isn’t registered isn’t resumed when its check passes', async () => {
  const { r, d } = await unregisteredRestart({ signIn: { ok: true, code: 0, at: 2 }, saved: { state: 'signin', resume: { why: 'signin', at: 1 } } });
  back(r);
  await quiet(r);
  back(r);
  await quiet(r);
  assert.ok(r.hosts.calls.signIn >= 1, `checks run: ${r.hosts.calls.signIn}`);
  assert.equal(failed(r).length, 0, 'no failed reply from a resume');
  assert.equal(r.se().remoteTurn.autoResumes ?? 0, 0);
  assert.equal(r.se().remoteTurn.state, 'signin');
  assert.equal(starts(d).length, 0);
});

test('#909 an agent moved off the host says so, though its backend isn’t registered either', async () => {
  const { r } = await unregisteredRestart({ moved: true });
  const items = failed(r);
  assert.equal(items.length, 1);
  assert.equal(items[0].error, 'Interrupted on host.example.com: @coder no longer runs there.');
  assert.equal(r.se().remoteTurn.state, 'interrupted');
});

test('#909 a host turn the host has no record of says so, though its backend isn’t registered either', async () => {
  const { r } = await unregisteredRestart({ welcome: 'missing' });
  const items = failed(r);
  assert.equal(items.length, 1, 'no failed reply from a resume');
  assert.equal(items[0].error, 'Interrupted on host.example.com: the host has no record of it.');
  assert.equal(r.se().remoteTurn.autoResumes ?? 0, 0);
});

test('#909 an agent moved off the host says so, though the host has no record of the turn either', async () => {
  const { r } = await unregisteredRestart({ moved: true, welcome: 'missing' });
  assert.deepEqual(
    failed(r).map((i) => i.error),
    ['Interrupted on host.example.com: @coder no longer runs there.'],
  );
});
