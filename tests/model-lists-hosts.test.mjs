// A backend’s models on a host (server/model-lists.mjs, #1304): asked through its adapter of what the host’s CLI
// lists, used for a minute and kept per host, apart from this computer’s list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { ModelLists } from '../server/model-lists.mjs';
import { tempDir } from './temp-dirs.mjs';

const REMOTE = { stdin: 'held' };

/** An adapter that can run on a host; its own CLI here lists local. */
function remoteAdapter(name, local = ['here-1']) {
  return {
    name,
    capabilities: { remote: REMOTE },
    asked: 0,
    listModels(listed = async () => local) {
      this.asked++;
      return listed();
    },
  };
}

function setup({ adapter = remoteAdapter('kiro-cli'), onHost = async () => ['host-1', 'host-2'], now = () => 0, hostIds } = {}) {
  const file = join(tempDir('pb-host-models-'), 'model-lists.json');
  const calls = [];
  const listOnHost = (hostId, backend) => {
    calls.push([hostId, backend]);
    return onHost(hostId, backend);
  };
  const lists = new ModelLists(new AdapterRegistry().register(adapter, { here: false }), { file, now, listOnHost, hostIds });
  return { file, adapter, calls, lists };
}

test('an agent on a host gets the host’s list, kept apart from this computer’s', async () => {
  const { file, adapter, calls, lists } = setup();
  assert.deepEqual(await lists.list('kiro-cli', 'ho_1'), { models: ['host-1', 'host-2'], fresh: true });
  assert.deepEqual(calls, [['ho_1', 'kiro-cli']]);
  assert.equal(adapter.capabilities.models, undefined, 'what the backend offers here is unchanged');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'kiro-cli@ho_1': ['host-1', 'host-2'] });
});

test('Codex on a host offers auto beside the host’s list, as it does here', async () => {
  const workRoot = tempDir('pb-host-codex-');
  const { lists } = setup({ adapter: new CodexAdapter({ bin: 'codex', workRoot }), onHost: async () => ['gpt-6.1-sol'] });
  assert.deepEqual(await lists.list('codex', 'ho_1'), { models: ['gpt-6.1-sol', 'auto'], fresh: true });
});

test('a host’s list is used for a minute, each host on its own', async () => {
  let t = 0;
  const { calls, lists } = setup({ now: () => t });
  await lists.list('kiro-cli', 'ho_1');
  t = 59_000;
  await lists.list('kiro-cli', 'ho_1');
  await lists.list('kiro-cli', 'ho_2');
  assert.deepEqual(calls, [
    ['ho_1', 'kiro-cli'],
    ['ho_2', 'kiro-cli'],
  ]);
  t = 61_000;
  await lists.list('kiro-cli', 'ho_1');
  assert.equal(calls.length, 3);
});

test('a host that can’t be reached answers its last list, saying so', async () => {
  let reach = true;
  let t = 0;
  const { lists } = setup({
    now: () => t,
    onHost: async () => {
      if (reach) return ['host-1'];
      throw Object.assign(new Error('ssh: timed out'), { code: 'unreachable' });
    },
  });
  await lists.list('kiro-cli', 'ho_1');
  reach = false;
  t = 61_000;
  assert.deepEqual(await lists.list('kiro-cli', 'ho_1'), { models: ['host-1'], fresh: false, why: 'unreachable' });
});

test('a host whose daemon is older than `models` answers its last list, saying it’s outdated', async () => {
  const { lists } = setup({ onHost: async () => Promise.reject(Object.assign(new Error('“models” isn’t a message on this channel'), { code: 'outdated' })) });
  assert.deepEqual(await lists.list('kiro-cli', 'ho_1'), { models: [], fresh: false, why: 'outdated' });
});

test('a host whose CLI listed none is not-listed, not outdated', async () => {
  const { lists } = setup({ onHost: async () => Promise.reject(Object.assign(new Error('The host’s CLI listed no models.'), { code: 'not-listed' })) });
  assert.deepEqual(await lists.list('kiro-cli', 'ho_1'), { models: [], fresh: false, why: 'not-listed' });
});

test('a deleted host’s lists are forgotten: its cached list doesn’t answer, and the kept one goes at the next keep', async () => {
  const hosts = ['ho_1', 'ho_2'];
  let t = 0;
  const { file, lists } = setup({ hostIds: () => hosts, now: () => t });
  await lists.list('kiro-cli', 'ho_1');
  await lists.list('kiro-cli', 'ho_2');
  hosts.splice(0, 1);
  await assert.rejects(lists.list('kiro-cli', 'ho_1'), (e) => e.status === 404, 'not its cached list, fresh');
  t = 61_000;
  await lists.list('kiro-cli', 'ho_2');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['kiro-cli@ho_2']);
});

test('a host Postbox doesn’t have is a 404; a hostId that isn’t one is a 400; neither is asked', async () => {
  const { calls, lists } = setup({ onHost: async () => Promise.reject(Object.assign(new Error('No such host.'), { code: 'no-host' })) });
  await assert.rejects(lists.list('kiro-cli', 'ho_x'), (e) => e.status === 404);
  for (const bad of ['', '../x', 42, 'a'.repeat(65)]) await assert.rejects(lists.list('kiro-cli', bad), (e) => e.status === 400, String(bad));
  assert.equal(calls.length, 1);
});

test('a backend that can’t run on a host isn’t asked there', async () => {
  const local = { name: 'agent-sdk', capabilities: {}, listModels: async () => ['x'] };
  const { calls, lists } = setup({ adapter: /** @type {any} */ (local) });
  assert.deepEqual(await lists.list('agent-sdk', 'ho_1'), { models: [], fresh: false, why: 'not-listed' });
  assert.equal(calls.length, 0);
});
