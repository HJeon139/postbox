// The GPT boilerplate’s model survives persona creation and reaches Codex’s wire requests.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { BOILERPLATES } from '../server/seed.mjs';
import { Store } from '../server/store.mjs';
import { applyBoilerplate, modelName, runsWith, shortModel } from '../shared/agent-facts.mjs';

function recordedServer(seen) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 0);
  const events = readFileSync(new URL('fixtures/codex-app-server/turn.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString());
    seen.push(request);
    if (request.id) child.stdout.write(`${JSON.stringify(events.find((event) => event.id === request.id))}\n`);
    if (request.method === 'turn/start')
      setImmediate(() => {
        for (const event of events.filter((event) => event.method)) child.stdout.write(`${JSON.stringify(event)}\n`);
      });
  });
  return child;
}

for (const [models, inherited] of [
  [undefined, null],
  [[], null],
  [['gpt-example'], null],
  [[], 'claude-sonnet-5-5'],
]) {
  test(`${inherited ?? 'GPT'} uses ${models?.length ? 'the reported Codex model' : `the Codex default with ${models ? 'an empty' : 'no'} catalog`}`, async () => {
    const seen = [];
    const reported = [];
    const adapter = new CodexAdapter({ workRoot: '/tmp/pb-gpt-regression', models, spawnImpl: () => recordedServer(seen) });
    const rt = new Runtime({
      store: new Store(null),
      adapters: new AdapterRegistry().register(adapter),
      corpus: {},
      config: { home: '/tmp/pb-gpt-regression' },
    });
    const draft = { handle: 'helper' };
    applyBoilerplate(
      draft,
      BOILERPLATES.find((b) => b.id === 'bp-gpt'),
      { adapters: ['codex'], backends: { codex: { models } } },
    );
    const persona = rt.createPersona({ ...draft, model: inherited ?? draft.model, tools: [...draft.tools] });
    rt.store.emit('project', { id: 'project', name: 'Project', folder: '/tmp/pb-gpt-regression' });
    const thread = rt.createThread({ projectId: 'project', title: 'GPT', personaIds: [persona.id] });
    const session = rt.ensureSession(thread.id, persona.id);
    const snapshot = rt.personaFor(session);
    await adapter.deliver(
      session,
      { kind: 'user', text: 'Say hello.' },
      {
        persona: snapshot,
        project: { folder: '/tmp/pb-gpt-regression' },
        handles: ['helper'],
        state: {},
        signal: new AbortController().signal,
        mcpUrl: 'http://127.0.0.1:1/mcp?session=test',
        reported: (value) => reported.push(value),
        text: () => {},
        activity: () => {},
        status: () => {},
        saveState: () => {},
        checkpoint: () => {},
        pathOf: () => null,
      },
    );
    for (const method of ['thread/start', 'turn/start']) {
      const request = seen.find((request) => request.method === method);
      assert.ok(request, `${method} reached the app-server`);
      assert.equal(request.params.model, models?.[0]);
      assert.equal(Object.hasOwn(request.params, 'model'), !!models?.length);
    }
    assert.equal(modelName('codex', runsWith(session, persona, {}).setModel), models?.[0] ? shortModel(models[0]) : 'Codex’s default');
    assert.deepEqual(reported, [{ ...(models?.length ? { model: models[0] } : {}), effort: 'medium' }]);
  });
}
