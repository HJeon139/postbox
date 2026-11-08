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

test('#995 show_block with an app block takes the intent as show_app does: never refused for it', () => {
  const { store, tools } = setup();
  const app = (id, intent) => ({ block: { id, type: 'app', version: 1, fallback: 'An app.', code: '<p>1</p>', intent } });
  assert.equal(tools.show_block(app('num', 42)).ok, true);
  assert.equal(tools.show_block(app('long', `  ${'x'.repeat(INTENT_CHARS + 50)}  `)).ok, true);
  assert.equal(tools.show_block(app('said', '  Six cost over $10 a use. ')).ok, true);
  assert.deepEqual(intents(store, 'num'), ['']);
  assert.equal(intents(store, 'long')[0].length, INTENT_CHARS);
  assert.deepEqual(intents(store, 'said'), ['Six cost over $10 a use.']);
});

test('#995 16 words is within the limit, and every way of showing an app flags a longer intent once, with its true length', () => {
  const { tools } = setup();
  const words = (n) => Array.from({ length: n }, () => 'word').join(' ');
  const flags = (r) => (r.message.match(/Its intent has/g) ?? []).length;
  assert.equal(flags(tools.show_app({ id: 'at', title: 'A', code: '<p>1</p>', intent: words(16) })), 0, 'exactly 16 is fine');
  const over = tools.show_app({ id: 'over', title: 'B', code: '<p>1</p>', intent: words(17) });
  assert.equal(flags(over), 1);
  assert.match(over.message, /Its intent has 17 words/);
  const block = (id, intent) => ({ block: { id, type: 'app', version: 1, fallback: 'An app.', code: '<p>1</p>', intent } });
  const shown = tools.show_block(block('new', words(20)));
  assert.equal(flags(shown), 1, 'show_block’s new app');
  assert.match(shown.message, /Its intent has 20 words/);
  assert.equal(flags(tools.show_block(block('new', words(21)))), 1, 'show_block on an app it already holds');
  assert.equal(flags(tools.show_app({ id: 'new', title: 'C', code: '<p>2</p>', intent: words(22) })), 1, 'show_app on an app it already holds');
  // 200 words is past the 300-character cut: the note gives the length the agent wrote.
  assert.match(tools.show_app({ id: 'huge', title: 'D', code: '<p>1</p>', intent: words(200) }).message, /Its intent has 200 words/);
});
