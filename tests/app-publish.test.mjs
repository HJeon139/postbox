// #1478: an app publishes its data for its agent, which reads it with read_app and hears of a change at its next turn,
// with no turn started, no card and nobody needing the person.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { publishApp, readApp } from '../server/app-publish.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

class QuietAdapter {
  name = 'mock';
  calls = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message) {
    this.calls.push(message);
  }
}

function withApp() {
  const store = new Store(null);
  const adapter = new QuietAdapter();
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'alpha' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const other = rt.createThread({ projectId: 'p1', title: 'U', personaIds: [a.id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'list', title: 'Reading list', code: '<p>x</p>', permissions: [] });
  return { rt, store, se, t, other, adapter };
}

const notices = (rt, se) => rt.delivery.waiting(se.id).filter((e) => e.source === 'notice' && e.text.startsWith('[app list]'));

test('#1478 publish keeps the app’s data and waits one notice for the agent’s next turn: no turn, no card, nobody needs you', () => {
  const { rt, store, se, t, adapter } = withApp();
  const calls = adapter.calls.length;
  publishApp(rt, 'list', { rows: [{ title: 'Emma', rating: 4 }] });
  publishApp(rt, 'list', { rows: [{ title: 'Emma', rating: 5 }] });
  assert.deepEqual(store.state.apps.list.published, { rows: [{ title: 'Emma', rating: 5 }] });
  assert.equal(notices(rt, se).length, 1, 'a burst of changes is one notice');
  assert.match(notices(rt, se)[0].text, /read_app/);
  assert.equal(adapter.calls.length, calls, 'no turn started');
  assert.equal(store.items(t.id).filter((x) => x.kind === 'appsend' || x.kind === 'voice').length, 0);
  assert.equal(rt.s.sessions[se.id].needs ?? null, null);
});

test('#1478 the same data again changes nothing; more than 256 KB is refused; a retired app can’t publish', () => {
  const { rt, store, se } = withApp();
  publishApp(rt, 'list', { n: 1 });
  const before = store.state.apps.list;
  assert.deepEqual(publishApp(rt, 'list', { n: 1 }), { ok: true, unchanged: true });
  assert.equal(store.state.apps.list, before, 'no write');
  assert.throws(
    () => publishApp(rt, 'list', { big: 'x'.repeat(300 * 1024) }),
    (e) => e.status === 413,
  );
  rt.toolsFor(se.id).retire_app({ id: 'list', reason: 'Replaced.' });
  assert.throws(
    () => publishApp(rt, 'list', { n: 2 }),
    (e) => e.status === 409,
  );
});

test('#1478 read_app gives what the app published and its saved state, only for an app in the agent’s conversation', () => {
  const { rt, se, other } = withApp();
  rt.appState('list', { tab: 'books' });
  publishApp(rt, 'list', { rows: [] });
  const read = readApp(rt, se.id, { appId: 'list' });
  assert.equal(read.ok, true);
  const out = JSON.parse(read.message);
  assert.deepEqual([out.title, out.version, out.published, out.savedState], ['Reading list', 1, { rows: [] }, { tab: 'books' }]);
  assert.equal(readApp(rt, se.id, { appId: 'nope' }).ok, false);
  const elsewhere = arrange.sessionsIn(rt, other.id)[0];
  assert.equal(readApp(rt, elsewhere.id, { appId: 'list' }).ok, false, 'another conversation’s app');
});
