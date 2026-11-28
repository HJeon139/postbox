// What Postbox keeps of each model’s last turn (#1977, server/model-runs.mjs): read from the turn’s structured end,
// kept per backend and host in the data folder, and answered with the list of models. A harness lists what it knows,
// not what the sign-in may run: on the owner’s host the first of 13 listed was refused before its first step.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { withQuota, withTransient } from '../server/harness-failure.mjs';
import { ModelLists } from '../server/model-lists.mjs';
import { ModelRuns } from '../server/model-runs.mjs';
import { tempDir } from './temp-dirs.mjs';

const PERSONAS = {
  here: { backend: 'claude-code', model: 'claude-sonnet-4-6' },
  away: { backend: 'claude-code', model: 'us.opus-new', remote: { hostId: 'ho_1' } },
  mock: { backend: 'mock', model: 'mock' },
};

function setup({ hosts = ['ho_1'] } = {}) {
  let t = 1000;
  const file = join(tempDir('pb-model-runs-'), 'model-runs.json');
  const runs = new ModelRuns({ file, now: () => t++, hostIds: () => hosts });
  const bus = new EventEmitter();
  runs.listen({ bus, s: { personas: PERSONAS } });
  const ended = (/** @type {keyof typeof PERSONAS} */ who, turn = {}) =>
    bus.emit('turn.ended', { turn: { steps: [], said: 'Done.', ...turn }, se: { personaId: who } });
  const failed = (/** @type {keyof typeof PERSONAS} */ who, turn = {}, how = {}) =>
    bus.emit('turn.failed', {
      turn: { steps: [], said: '', endErr: new Error('403 not available for this account'), ...turn },
      se: { personaId: who },
      ...how,
    });
  return { file, runs, ended, failed, hosts };
}

test('a turn that ended with a reply says its model answered, here or on its host, each kept apart', () => {
  const { runs, ended } = setup();
  ended('here');
  ended('away');
  assert.deepEqual(runs.of('claude-code'), { 'claude-sonnet-4-6': { ended: 'answered', at: 1000 } });
  assert.deepEqual(runs.of('claude-code', 'ho_1'), { 'us.opus-new': { ended: 'answered', at: 1001 } });
  assert.deepEqual(runs.of('claude-code', 'ho_2'), {});
});

test('a turn that failed before its first step says so, with the harness’s words, cut to a length', () => {
  const { runs, failed } = setup();
  failed('away');
  assert.deepEqual(runs.of('claude-code', 'ho_1'), { 'us.opus-new': { ended: 'failed', at: 1000, why: '403 not available for this account' } });
  failed('away', { endErr: Object.assign(new Error('raw'), { userMessage: `Told the person. ${'x'.repeat(400)}` }) });
  const kept = runs.of('claude-code', 'ho_1')['us.opus-new'];
  assert.equal(kept.at, 1001, 'a failure is kept each time, with when');
  assert.ok(String(kept.why).startsWith('Told the person.') && String(kept.why).length <= 301, 'the words shown, bounded');
});

test('a failure that isn’t about the model says nothing of it: a step taken, words said, the network, the quota, a passing failure, a resend', () => {
  const { runs, failed } = setup();
  failed('away', { steps: [{ kind: 'tool', label: 'Read a file' }] });
  failed('away', { said: 'I started, then' });
  failed('away', { endErr: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
  failed('away', { endErr: withQuota(new Error('quota'), { until: null }) });
  failed('away', { endErr: withTransient(new Error('overloaded'), 529) });
  failed('away', {}, { lost: true });
  failed('away', {}, { resends: true });
  // A host’s own failure, Sign-in needed or Interrupted, is about the host and not the model that ran there.
  failed('away', { endErr: Object.assign(new Error('Sign-in needed on build-box.'), { remote: { state: 'signin', hostId: 'ho_1' } }) });
  assert.deepEqual(runs.of('claude-code', 'ho_1'), {});
  // A thought, narration or a subagent’s step is not the agent’s own first step.
  failed('away', { steps: [{ kind: 'thought' }, { kind: 'said' }, { kind: 'tool', who: 'subagent' }] });
  assert.equal(runs.of('claude-code', 'ho_1')['us.opus-new'].ended, 'failed');
});

test('an answer after an answer writes nothing, an answer after a failure replaces it, and the mock is never kept', () => {
  const { file, runs, ended, failed } = setup();
  ended('mock');
  assert.equal(existsSync(file), false, 'the mock runs no model');
  ended('here');
  const first = readFileSync(file, 'utf8');
  ended('here');
  ended('here');
  assert.equal(readFileSync(file, 'utf8'), first, 'a room that runs all day writes once');
  failed('here');
  assert.equal(runs.of('claude-code')['claude-sonnet-4-6'].ended, 'failed');
  ended('here');
  assert.deepEqual(runs.of('claude-code')['claude-sonnet-4-6'], { ended: 'answered', at: 1002 });
});

test('a deleted host’s records go at the next write, a model id that isn’t one is never kept, and a closed Postbox keeps nothing', () => {
  const { runs, ended, hosts } = setup();
  ended('away');
  hosts.length = 0;
  ended('here');
  assert.deepEqual(runs.of('claude-code', 'ho_1'), {});
  runs.record('claude-code', '--dangerously', 'answered');
  runs.record('claude-code', 'x'.repeat(200), 'answered');
  assert.deepEqual(Object.keys(runs.of('claude-code')), ['claude-sonnet-4-6']);
  runs.close();
  runs.record('claude-code', 'late-model', 'answered');
  assert.equal('late-model' in runs.of('claude-code'), false);
});

test('at most 60 models are kept for a backend, the newest', () => {
  const { runs } = setup();
  for (let i = 0; i < 65; i++) runs.record('claude-code', `m-${i}`, 'answered');
  const kept = Object.keys(runs.of('claude-code'));
  assert.equal(kept.length, 60);
  assert.ok(kept.includes('m-64') && !kept.includes('m-0'));
});

test('a list of models is answered with what was kept for it, and is as it was while nothing is', async () => {
  const file = join(tempDir('pb-model-runs-list-'), 'model-lists.json');
  const adapter = { name: 'kiro-cli', capabilities: {}, listModels: async () => ['m-1', 'm-2'] };
  const lists = new ModelLists(new AdapterRegistry().register(adapter, { here: true }), { file, now: () => 7 });
  assert.deepEqual(await lists.list('kiro-cli'), { models: ['m-1', 'm-2'], fresh: true });
  lists.runs.record('kiro-cli', 'm-2', 'failed', 'not offered to this sign-in');
  assert.deepEqual(await lists.list('kiro-cli'), {
    models: ['m-1', 'm-2'],
    fresh: true,
    ran: { 'm-2': { ended: 'failed', at: 7, why: 'not offered to this sign-in' } },
  });
  lists.close();
  lists.runs.record('kiro-cli', 'm-1', 'answered');
  assert.equal('m-1' in lists.runs.of('kiro-cli'), false, 'closing the lists closes the record');
});

test('a turn is kept where it ran: the host its turn was on, when that differs from where its agent is placed now', () => {
  const { runs, ended } = setup({ hosts: ['ho_1', 'ho_2'] });
  ended('away', { remote: { hostId: 'ho_2' } });
  assert.deepEqual(Object.keys(runs.of('claude-code', 'ho_2')), ['us.opus-new']);
  assert.deepEqual(runs.of('claude-code', 'ho_1'), {});
});

test('what is kept is read from the file once: a turn’s end reads nothing from disk, and a new start reads what was written', () => {
  const { file, runs, ended } = setup();
  ended('here');
  writeFileSync(file, '{"claude-code":{"written-behind-its-back":{"ended":"answered","at":1}}}');
  assert.deepEqual(Object.keys(runs.of('claude-code')), ['claude-sonnet-4-6'], 'not read again');
  ended('away');
  assert.deepEqual(Object.keys(new ModelRuns({ file }).of('claude-code')), ['claude-sonnet-4-6'], 'and the next write is of what it holds');
  assert.deepEqual(Object.keys(new ModelRuns({ file }).of('claude-code', 'ho_1')), ['us.opus-new']);
});

test('hosted, an answer carries how a turn ended and when, and never the harness’s words, which stay in the file', () => {
  const file = join(tempDir('pb-model-runs-hosted-'), 'model-runs.json');
  const runs = new ModelRuns({ file, now: () => 5, reasons: false });
  runs.record('claude-code@ho_1', 'us.opus-new', 'failed', 'arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.opus-new is not available');
  assert.deepEqual(runs.of('claude-code', 'ho_1'), { 'us.opus-new': { ended: 'failed', at: 5 } });
  assert.match(readFileSync(file, 'utf8'), /inference-profile/);
});
