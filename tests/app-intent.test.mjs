// An app’s intent (#995): one sentence, what the picture should leave the reader with. Postbox keeps it with the
// version, so a judge can compare it with what the picture alone says. A missing intent never refuses an app.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { INTENT_CHARS } from '../shared/limits.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

class Quiet {
  name = 'mock';
  async folderFor() {
    return null;
  }
  async deliver() {}
}

function setup() {
  const store = new Store(null);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(new Quiet()), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const a = rt.createPersona({ handle: 'researcher' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const [se] = rt.sessionsIn(t.id);
  return { store, tools: rt.toolsFor(se.id) };
}
const intents = (store, id) => store.state.apps[id].versions.map((v) => v.intent);

test('#995 show_app keeps the intent with the version, and update_app keeps the last one unless it names a new one', () => {
  const { store, tools } = setup();
  const said = 'Doubling the batch halves the steps, not the time.';
  assert.equal(tools.show_app({ id: 'lab', title: 'Batches', code: '<p>1</p>', intent: `  ${said} ` }).ok, true);
  tools.update_app({ id: 'lab', code: '<p>2</p>' });
  tools.update_app({ id: 'lab', code: '<p>3</p>', intent: 'The time stays flat.' });
  assert.deepEqual(intents(store, 'lab'), [said, said, 'The time stays flat.']);
  // show_app with an id the session holds is a new version, so it takes an intent too.
  tools.show_app({ id: 'lab', title: 'Batches', code: '<p>4</p>', intent: 'Steps fall as the batch grows.' });
  assert.equal(intents(store, 'lab')[3], 'Steps fall as the batch grows.');
});

test('#995 a missing, malformed or long intent never refuses an app', () => {
  const { store, tools } = setup();
  assert.equal(tools.show_app({ id: 'none', title: 'A', code: '<p>1</p>' }).ok, true);
  assert.equal(tools.show_app({ id: 'odd', title: 'B', code: '<p>1</p>', intent: 42 }).ok, true);
  assert.equal(tools.show_app({ id: 'long', title: 'C', code: '<p>1</p>', intent: 'x'.repeat(INTENT_CHARS + 50) }).ok, true);
  assert.deepEqual(intents(store, 'none'), ['']);
  assert.deepEqual(intents(store, 'odd'), ['']);
  assert.equal(intents(store, 'long')[0].length, INTENT_CHARS);
});

test('#995 show_app and update_app offer intent, and neither requires it', () => {
  for (const name of ['show_app', 'update_app']) {
    const def = TOOL_DEFS.find((t) => t.name === name);
    assert.equal(def?.inputSchema.properties.intent?.type, 'string', `${name} has no intent`);
    assert.ok(!def.inputSchema.required.includes('intent'), `${name} requires intent`);
  }
});

test('#995 an intent over 16 words is kept and flagged, so the agent can say it shorter', () => {
  const { store, tools } = setup();
  const long = 'This picture shows how the monthly cost of each subscription compares with how often you actually used it lately.';
  const shown = tools.show_app({ id: 'lab', title: 'A', code: '<p>1</p>', intent: long });
  assert.equal(shown.ok, true);
  assert.match(shown.message, /Its intent has 19 words: say it in at most 16 with update_app\./);
  assert.equal(intents(store, 'lab')[0], long);
  const short = tools.update_app({ id: 'lab', code: '<p>2</p>', intent: 'Six subscriptions cost over $10 a use.' });
  assert.doesNotMatch(short.message, /Its intent has/);
  assert.match(tools.update_app({ id: 'lab', code: '<p>3</p>', intent: long }).message, /Its intent has 19 words/);
});
