// An invalid block isn’t shown (#455): the demo’s @indexer, asked for a timeline Postbox can’t draw, gets its three
// blocks refused in the call and gives their plain-text versions instead, so no broken card reaches the person.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { MockAdapter } from '../server/adapters/mock.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

process.env.POSTBOX_MOCK_SPEED = '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#455 the demo’s invalid blocks are refused in the call, and the agent replies with their fallbacks', async () => {
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(new MockAdapter()),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const indexer = rt.createPersona({ handle: 'indexer', backend: 'mock' });
  const t = rt.createThread({ projectId: 'p1', title: 'Index the shelf', personaIds: [indexer.id] });
  rt.sendMessage(t.id, { text: 'Show it as a timeline' });
  for (let i = 0; i < 200 && (rt.turns.size || !store.items(t.id).some((x) => x.kind === 'agent' && x.status !== 'streaming')); i++) await sleep(10);
  assert.deepEqual(
    store.items(t.id).filter((x) => x.kind === 'block'),
    [],
    'no block, valid or not, reaches the person',
  );
  const reply = store
    .items(t.id)
    .filter((x) => x.kind === 'agent')
    .map((x) => x.text)
    .join('\n');
  assert.match(reply, /Postbox couldn’t show the timeline and its steps, so here they are in plain text:/);
  for (const plain of ['Chapters by length: Moby-Dick 135', 'Steps: drop prefaces (done)', 'Rebuild which first: Middlemarch, Emma or Persuasion?'])
    assert.ok(reply.includes(`- ${plain}`), plain);
});
