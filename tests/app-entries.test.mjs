// An app’s event, and its check’s problems, are inbox entries (#1425; designs/rooms-at-scale.md, “What an entry is”). An
// event’s entry points at the voice line it posts, and keeps no copy of what the app sent: the payload is held in
// memory for the turn that takes it, as a waiting event was before, so it never enters the public inbox. After a
// restart the turn reads the voice line in its place.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import * as arrange from './arrange.mjs';
import { held, ScriptedAdapter, settle, setup, sleep } from './side-threads-fixture.mjs';

/** @beta busy in a turn held open, with an app of its own. */
async function busyWithApp() {
  const f = setup();
  f.rt.toolsFor(f.beta.id).show_app({ id: 'lab', title: 'Lab', code: '<p>x</p>', permissions: [] });
  const busy = held();
  f.adapter.next.push(busy.step);
  f.rt.sendMessage(f.t.id, { text: '@beta start' });
  await sleep(5);
  return { ...f, busy };
}
const voiceOf = (store, t) => store.items(t.id).filter((i) => i.kind === 'voice' && i.appId === 'lab');
const eventsTo = (adapter, se) => adapter.calls.filter((c) => c.sessionId === se.id && c.message.kind === 'event').map((c) => c.message.event);

test('#1425 an app’s event for a busy agent waits as an entry for its voice line, with nothing the app sent in the inbox', async () => {
  const f = await busyWithApp();
  f.rt.appEvent('lab', 'try', { secret: 'a value only the turn reads' });
  const [voice] = voiceOf(f.store, f.t);
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.beta.id).map((e) => [e.source, e.itemId, e.from]),
    [['event', voice.id, 'you']],
  );
  assert.ok(!JSON.stringify(f.store.state.inbox).includes('a value only the turn reads'), 'the payload isn’t in the public inbox');
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(
    eventsTo(f.adapter, f.beta).map((ev) => [ev.blockId, ev.action, ev.values.secret]),
    [['lab', 'try', 'a value only the turn reads']],
  );
});

test('#1425 the events the person allows on an app’s card are entries too, each given once', async () => {
  const f = await busyWithApp();
  f.rt.appEvent('lab', 'one', { n: 1 }, { hold: true });
  f.rt.appEvent('lab', 'two', { n: 2 }, { hold: true });
  const card = f.store.items(f.t.id).find((x) => x.kind === 'appsend');
  f.rt.resolveAppSend(f.t.id, card.id, 'allow');
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.beta.id).map((e) => e.source),
    ['event', 'event'],
  );
  f.busy.release();
  await settle(f.rt);
  assert.deepEqual(
    eventsTo(f.adapter, f.beta).map((ev) => ev.action),
    ['one', 'two'],
  );
});

test('#1425 an app’s check that needs a fix is a check entry, and its turn gets the problems', async () => {
  const f = await busyWithApp();
  const problems = [{ code: 'overflow', message: 'The chart runs past the frame.' }];
  assert.deepEqual(f.rt.appCheck('lab', { version: 1, problems }), { status: 'fixing' });
  assert.deepEqual(
    arrange.waitingEntries(f.rt, f.beta.id).map((e) => e.source),
    ['check'],
  );
  f.busy.release();
  await settle(f.rt);
  const check = f.adapter.calls.find((c) => c.sessionId === f.beta.id && c.message.kind === 'app-check');
  assert.equal(check?.message.problems[0].code, 'overflow');
});

test('#1425 after a restart, a waiting event’s turn reads its voice line, since what the app sent was held in memory', async () => {
  const f = await busyWithApp();
  f.rt.appEvent('lab', 'try', { n: 3 });
  const [voice] = voiceOf(f.store, f.t);
  const after = new ScriptedAdapter();
  const again = new Runtime({ store: f.store, adapters: new AdapterRegistry().register(after), config: f.rt.config });
  again.drainAll();
  await settle(again);
  const call = after.calls.find((c) => c.sessionId === f.beta.id && c.message.kind === 'notice' && c.message.text.includes(voice.text));
  assert.ok(call, JSON.stringify(after.calls.map((c) => c.message)));
  assert.match(call.message.text, /Postbox restarted before it reached you/);
  f.busy.release();
  await settle(f.rt);
});
