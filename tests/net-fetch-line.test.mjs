// What an app fetched shows in its agent’s activity: one step per app per turn, naming each host and how often, on the
// agent’s reply, every attempt included, refused, failed and timed out too. Never a message, a needs-you or a card, and
// a polling app’s fetches patch the reply at most once per wait.

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { fetchLabel, noteFetch, PATCH_MS } from '../server/net-fetch-line.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import * as arrange from './arrange.mjs';

class QuietAdapter {
  name = 'mock';
  async folderFor() {
    return null;
  }
  async deliver() {}
}

/** A room with one agent, its app that holds net.fetch, and the agent’s reply. @param {string} appId @param {any} [activity] */
function room(appId, activity = { steps: [] }) {
  const store = new Store(null);
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new QuietAdapter()), config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'alpha' }).id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  rt.toolsFor(se.id).show_app({ id: appId, title: 'Visits', code: '<p>x</p>', permissions: ['net.fetch'] });
  const reply = rt.threads.addItem(t.id, {
    kind: 'agent',
    sessionId: se.id,
    turnId: `tu_${appId}`,
    text: 'Here it is.',
    status: 'done',
    ...(activity ? { activity } : {}),
  });
  const labels = () => (store.item(t.id, reply.id).activity?.steps ?? []).map((s) => [s.label, s.state]);
  return { store, rt, t, se, reply, app: rt.s.apps[appId], labels };
}

test('the line names the app, then each host with a count past one, then what it tried and didn’t get', () => {
  const tries = new Map([
    [
      'fetched',
      new Map([
        ['data.example.org', 3],
        ['api.example.com', 1],
      ]),
    ],
    ['refused', new Map([['10.0.0.1', 2]])],
    ['timed out', new Map([['slow.example.net', 1]])],
  ]);
  assert.equal(fetchLabel('Visits', tries), 'Visits fetched data.example.org ×3, api.example.com; tried 10.0.0.1 ×2 (refused), slow.example.net (timed out)');
  assert.equal(fetchLabel('Visits', new Map([['failed', new Map([['down.example', 1]])]])), 'Visits tried down.example (failed)');
});

test('fetches of one app after a turn are one step on that turn’s reply, counted per host; nobody needs the person', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, rt, t: th, se, app, labels } = room('visits');
  const before = store.items(th.id).length;
  for (const host of ['data.example.org', 'data.example.org', 'api.example.com', 'data.example.org']) noteFetch(rt.apps, app, host, 'fetched');
  t.mock.timers.tick(PATCH_MS);
  assert.deepEqual(labels(), [['Visits fetched data.example.org ×3, api.example.com', 'done']]);
  assert.equal(store.items(th.id).length, before, 'no message');
  assert.equal(rt.s.sessions[se.id].needs ?? null, null, 'nobody needs the person');
});

test('a reply that has no activity yet still gets the step', () => {
  const { rt, app, labels } = room('bare', null);
  noteFetch(rt.apps, app, 'data.example.org', 'fetched');
  assert.deepEqual(labels(), [['Visits fetched data.example.org', 'done']]);
});

test('a fetch net.fetch refuses shows in the activity too, as tried and refused, not as an alarm', async () => {
  const { rt, se, app, labels } = room('refused');
  await assert.rejects(rt.appQuery(app.id, 'net.fetch', { url: 'http://10.0.0.1/collect?d=secret' }), (e) => e.status === 403);
  assert.deepEqual(labels(), [['Visits tried 10.0.0.1 (refused)', 'done']]);
  assert.equal(rt.s.sessions[se.id].needs ?? null, null, 'nobody needs the person');
});

test('a polling app patches its reply at most once per wait, with the latest count', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, rt, app, labels } = room('poller');
  const emit = mock.method(store, 'emit');
  const patches = () => emit.mock.calls.filter((c) => c.arguments[0] === 'item.patch').length;
  for (let i = 0; i < 20; i++) noteFetch(rt.apps, app, 'data.example.org', 'fetched');
  assert.equal(patches(), 1, 'the first fetch shows at once');
  t.mock.timers.tick(PATCH_MS);
  assert.equal(patches(), 2, 'the rest come together when the wait ends');
  assert.deepEqual(labels(), [['Visits fetched data.example.org ×20', 'done']]);
  t.mock.timers.tick(PATCH_MS);
  assert.equal(patches(), 2, 'no patch when nothing changed');
});

test('the line names at most 20 hosts; past them, new hosts are counted as other hosts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { rt, app, labels } = room('many');
  for (let i = 1; i <= 25; i++) noteFetch(rt.apps, app, `h${i}.io`, 'fetched');
  noteFetch(rt.apps, app, 'h1.io', 'fetched');
  t.mock.timers.tick(PATCH_MS);
  const [[label]] = labels();
  assert.equal(label, `Visits fetched h1.io ×2, ${Array.from({ length: 19 }, (_, i) => `h${i + 2}.io`).join(', ')}, other hosts ×5`);
});
