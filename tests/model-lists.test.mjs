import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ModelLists } from '../server/model-lists.mjs';
import { tempDir } from './temp-dirs.mjs';

/** An adapter whose harness answers each listModels() with the next of answers. */
function lister(name, answers, capabilities = {}) {
  return {
    name,
    capabilities,
    asked: 0,
    async listModels() {
      this.asked++;
      return answers.shift() ?? [];
    },
  };
}

function setup({ answers = [['m-1', 'm-2']], here = true, now = () => 0, capabilities = {} } = {}) {
  const file = join(tempDir('pb-models-'), 'model-lists.json');
  const adapter = lister('kiro-cli', answers, capabilities);
  const adapters = new AdapterRegistry().register(adapter, { here });
  return { file, adapter, adapters, lists: new ModelLists(adapters, { file, now }) };
}

test('a backend’s models come from its harness, and become what it offers', async () => {
  const { adapter, lists } = setup();
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1', 'm-2'], fresh: true });
  assert.deepEqual(adapter.capabilities.models, ['m-1', 'm-2']);
});

test('asking again within a minute answers the list it has, without asking the harness', async () => {
  let t = 0;
  const { adapter, lists } = setup({ answers: [['m-1'], ['m-2']], now: () => t });
  await lists.list('kiro-cli');
  t = 59_000;
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1'], fresh: true });
  assert.equal(adapter.asked, 1);
  t = 61_000;
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-2'], fresh: true });
  assert.equal(adapter.asked, 2);
});

test('asks that arrive together share one call to the harness', async () => {
  const { adapter, lists } = setup();
  const [a, b] = await Promise.all([lists.list('kiro-cli'), lists.list('kiro-cli')]);
  assert.deepEqual(a, b);
  assert.equal(adapter.asked, 1);
});

test('when the harness lists nothing, the answer is the last list it gave, marked not fresh', async () => {
  let t = 0;
  const { adapter, lists } = setup({ answers: [['m-1'], []], now: () => t });
  await lists.list('kiro-cli');
  t = 61_000;
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1'], fresh: false });
  assert.deepEqual(adapter.capabilities.models, ['m-1'], 'a failed listing leaves what the backend offers');
});

test('a failed listing asks again on the next ask, not a minute later', async () => {
  const { adapter, lists } = setup({ answers: [[], ['m-1']] });
  assert.deepEqual(await lists.list('kiro-cli'), { models: [], fresh: false });
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1'], fresh: true });
  assert.equal(adapter.asked, 2);
});

test('the last list survives a restart: a new ModelLists offers it without asking the harness', async () => {
  const { file, lists } = setup();
  await lists.list('kiro-cli');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'kiro-cli': ['m-1', 'm-2'] });
  const again = lister('kiro-cli', []);
  new ModelLists(new AdapterRegistry().register(again), { file }).seed();
  assert.deepEqual(again.capabilities.models, ['m-1', 'm-2']);
  assert.equal(again.asked, 0);
});

test('a backend that runs only on a host isn’t asked here: its last list comes back, not fresh', async () => {
  const { adapter, lists } = setup({ here: false, capabilities: { models: ['auto'] } });
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['auto'], fresh: false });
  assert.equal(adapter.asked, 0);
});

test('a backend Postbox doesn’t have is a 404, and nothing is asked', async () => {
  const { adapter, lists } = setup();
  await assert.rejects(lists.list('nope'), (e) => e.status === 404 && /isn’t one Postbox runs/.test(e.message));
  await assert.rejects(lists.list('__proto__'), (e) => e.status === 404);
  assert.equal(adapter.asked, 0);
});

test('a harness that throws instead of answering counts as one that couldn’t list', async () => {
  const { adapter, lists } = setup({ capabilities: { models: ['m-0'] } });
  adapter.listModels = async () => Promise.reject(new Error('kiro-cli crashed'));
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-0'], fresh: false });
});

test('a kept entry that isn’t a list of models is ignored at start', async () => {
  const { file } = setup();
  writeFileSync(file, JSON.stringify({ 'kiro-cli': 'm-1', codex: ['gpt-5.6'] }));
  const kiro = lister('kiro-cli', []);
  const codex = lister('codex', []);
  new ModelLists(new AdapterRegistry().register(kiro).register(codex), { file }).seed();
  assert.equal(kiro.capabilities.models, undefined);
  assert.deepEqual(codex.capabilities.models, ['gpt-5.6']);
});

test('a list that can’t be kept is still answered, and the failure is logged', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const adapter = lister('kiro-cli', [['m-1']]);
  const file = join(tempDir('pb-models-'), 'missing-folder', 'model-lists.json');
  const lists = new ModelLists(new AdapterRegistry().register(adapter), { file });
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1'], fresh: true });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[0]), /couldn’t keep kiro-cli’s models/);
});
