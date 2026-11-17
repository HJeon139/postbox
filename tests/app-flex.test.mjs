// The flexible-apps prototype (designs/prototypes/flexible-apps.md): what an app shares with its agent without a card,
// and net.fetch’s refusals.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { noteApp, publishApp, readApp } from '../server/app-flex.mjs';
import { netFetch, privateAddress } from '../server/net-fetch.mjs';
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
  const se = arrange.sessionsIn(rt, t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'list', title: 'Reading list', code: '<p>x</p>', permissions: [] });
  return { rt, store, se, t, adapter };
}

const notices = (rt, se) => rt.delivery.waiting(se.id).filter((e) => e.source === 'notice' && e.text.startsWith('[app list]'));

test('publish keeps the app’s data for its agent and waits one notice for its next turn: no turn, no card, no line in your voice', () => {
  const { rt, store, se, t, adapter } = withApp();
  const calls = adapter.calls.length;
  publishApp(rt, 'list', { rows: [{ title: 'Emma', rating: 4 }] });
  publishApp(rt, 'list', { rows: [{ title: 'Emma', rating: 5 }] });
  assert.deepEqual(store.state.apps.list.published, { rows: [{ title: 'Emma', rating: 5 }] });
  assert.equal(notices(rt, se).length, 1, 'a burst of changes is one notice');
  assert.equal(adapter.calls.length, calls, 'no turn started');
  assert.equal(store.items(t.id).filter((x) => x.kind === 'appsend' || x.kind === 'voice').length, 0);
  assert.equal(rt.s.sessions[se.id].needs ?? null, null, 'nobody needs the person');
});

test('a send with no click is a note: kept on the app, folded into the same notice, and taken by read_app', () => {
  const { rt, se } = withApp();
  noteApp(rt, 'list', 'sorted', { by: 'rating' });
  noteApp(rt, 'list', 'filtered', { status: 'Done' });
  assert.equal(notices(rt, se).length, 1);
  const read = JSON.parse(readApp(rt, se.id, { appId: 'list' }).message);
  assert.deepEqual(
    read.notes.map((n) => n.action),
    ['sorted', 'filtered'],
  );
  assert.deepEqual(JSON.parse(readApp(rt, se.id, { appId: 'list' }).message).notes, [], 'reading takes them');
});

test('read_app refuses an app outside the agent’s conversation', () => {
  const { rt, se } = withApp();
  assert.equal(readApp(rt, se.id, { appId: 'nope' }).ok, false);
});

test('net.fetch refuses this computer and the local network by name or address, and URLs that carry credentials', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.3.20', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1'])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  for (const url of ['http://localhost:4517/api/state', 'http://192.168.3.20/', 'http://[::1]:80/', 'http://169.254.169.254/latest/'])
    await assert.rejects(netFetch({ url }), (e) => e.status === 403, url);
  await assert.rejects(netFetch({ url: 'https://user:pw@example.com/' }), (e) => e.status === 400);
  await assert.rejects(netFetch({ url: 'file:///etc/passwd' }), (e) => e.status === 400);
});
