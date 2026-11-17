// What an app fetched shows in its agent’s activity: one step per app per turn, naming each host and how often, on the
// agent’s reply. Never a message, a needs-you or a card.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { fetchLabel, noteFetch } from '../server/net-fetch-line.mjs';
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

test('the line names the app, then each host, with a count past one', () => {
  assert.equal(
    fetchLabel(
      'Visits',
      new Map([
        ['data.example.org', 3],
        ['api.example.com', 1],
      ]),
    ),
    'Visits fetched data.example.org ×3, api.example.com',
  );
});

test('fetches of one app after a turn are one step on that turn’s reply, counted per host; nobody needs the person', () => {
  const store = new Store(null);
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new QuietAdapter()), config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [rt.createPersona({ handle: 'alpha' }).id] });
  const se = arrange.sessionsIn(rt, t.id)[0];
  rt.toolsFor(se.id).show_app({ id: 'visits', title: 'Visits', code: '<p>x</p>', permissions: ['net.fetch'] });
  const reply = rt.threads.addItem(t.id, { kind: 'agent', sessionId: se.id, turnId: 'tu_1', text: 'Here it is.', status: 'done', activity: { steps: [] } });
  const before = store.items(t.id).length;
  const app = rt.s.apps.visits;
  for (const host of ['data.example.org', 'data.example.org', 'api.example.com', 'data.example.org']) noteFetch(rt.apps, app, host);
  const steps = store.item(t.id, reply.id).activity.steps;
  assert.deepEqual(
    steps.map((s) => [s.label, s.state]),
    [['Visits fetched data.example.org ×3, api.example.com', 'done']],
  );
  assert.equal(store.items(t.id).length, before, 'no message');
  assert.equal(rt.s.sessions[se.id].needs ?? null, null, 'nobody needs the person');
});
