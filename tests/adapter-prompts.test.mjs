// What each backend’s adapter records as a turn’s prompt in UAT recording mode (ctx.prompt, server/turn-prompt.mjs,
// #1528) is what it gives its CLI: the system text as the backend gets it, and the prompt itself, byte for byte, once
// the backend has it. Claude Code’s is in tests/turn-prompt.test.mjs. Each turn here plays a stream recorded on its
// CLI through the fakes its own tests use: Kiro’s kiro-cli 2.33.1 (tests/kiro-cli-fakes.mjs), Antigravity’s
// tests/fixtures/antigravity-cli/block.jsonl, Codex’s app-server answers (tests/codex-fixture.mjs) and claude 2.1.296’s
// tests/fixtures/claude-code/block.jsonl for the Agent SDK. A fake child emits `spawn` on the next tick, as Node’s
// does once a process has started. None waits on a timer.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { PLUGIN_DIR } from '../server/adapters/agy-plugin.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';
import { fixtureLines } from './fake-daemon.mjs';
import { fakeCtx as kiroCtx, fixture as kiroFixture, fakeSpawn as kiroSpawn } from './kiro-cli-fakes.mjs';
import { brokenStdin } from './prompt-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A spawn that emits `spawn` on the next tick, as Node’s does once the process has started. @param {Function} play */
const started =
  (play) =>
  (/** @type {any[]} */ ...a) => {
    const child = play(...a);
    process.nextTick(() => child.emit('spawn'));
    return child;
  };

/** A Kiro adapter in a temp folder, on a spawn. @param {any} spawnImpl */
const kiroOn = (spawnImpl) => {
  const root = tempDir('pb-prompt-kiro-');
  return new KiroCliAdapter({ workRoot: join(root, 'work'), isolatedHome: join(root, 'home'), spawnImpl, env: {} });
};

test('Kiro records the system prompt its agent file gives, with Postbox’s notes for Kiro, and the prompt it passes', async () => {
  const seen = [];
  const adapter = kiroOn(started(kiroSpawn([{ lines: kiroFixture('first'), code: 0 }], seen)));
  const recorded = [];
  await adapter.deliver({}, { kind: 'user', text: 'Remember heron.' }, kiroCtx({ prompt: (p) => recorded.push(p) }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].guide, seen[0].agentFile.prompt);
  assert.match(recorded[0].guide, /## Refused tool calls/, 'Postbox’s notes for Kiro, not only its guide');
  assert.equal(recorded[0].text, seen[0].args.at(-1));
});

test('Kiro records no prompt given as an argument when kiro never started (ENOENT)', async () => {
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const recorded = [];
  await assert.rejects(kiroOn(spawnImpl).deliver({}, { kind: 'user', text: 'Remember heron.' }, kiroCtx({ prompt: (p) => recorded.push(p) })));
  assert.deepEqual(recorded, []);
});

test('Kiro records a long prompt it gives on stdin once the write succeeded, and none when kiro exits before reading it', async () => {
  const text = 'y'.repeat(120_000); // past one argument’s length, so it goes on stdin (#362)
  const run = async (/** @type {() => any} */ stdin) => {
    const seen = [];
    const play = kiroSpawn([{ lines: kiroFixture('first'), code: 0 }], seen);
    const piped = [];
    const spawnImpl = (/** @type {any[]} */ ...a) => {
      const input = stdin();
      input.on('data', (/** @type {Buffer} */ d) => piped.push(String(d)));
      return Object.assign(play(...a), { stdin: input });
    };
    const recorded = [];
    await kiroOn(spawnImpl).deliver({}, { kind: 'user', text }, kiroCtx({ prompt: (p) => recorded.push(p) }));
    return { recorded, piped: piped.join('') };
  };
  const ok = await run(() => new PassThrough());
  assert.equal(ok.recorded.length, 1);
  assert.equal(ok.recorded[0].text, ok.piped, 'what kiro read');
  assert.deepEqual((await run(brokenStdin)).recorded, []);
});

/** The Antigravity spawn its tests use (tests/antigravity-cli.test.mjs): what the plugin’s rules file said as agy started. */
function agySpawn(lines, seen) {
  return (_bin, args, opts) => {
    const plugin = join(opts.cwd, PLUGIN_DIR);
    seen.push({ args, rules: existsSync(plugin) && readFileSync(join(plugin, 'rules', 'AGENTS.md'), 'utf8') });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    process.nextTick(() => child.emit('spawn'));
    setImmediate(() => {
      for (const e of lines) child.stdout.write(`${e}\n`);
      child.stdout.end();
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

/** An Antigravity turn's context, recording what it's given to record. @param {any[]} recorded */
const agyCtx = (recorded) => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [], description: '', instructions: '' },
  project: null,
  handles: ['gem'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  reported: () => {},
  prompt: (/** @type {any} */ p) => recorded.push(p),
});

test('Antigravity records the rules file agy reads, with its tool and approval notes, and the prompt it passes', async () => {
  const root = tempDir('pb-prompt-agy-');
  const seen = [];
  // A turn recorded on agy (tests/fixtures/antigravity-cli/block.jsonl).
  const lines = readFileSync(new URL('fixtures/antigravity-cli/block.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n');
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (agySpawn(lines, seen)),
    env: {},
  });
  const recorded = [];
  const ctx = agyCtx(recorded);
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  const guides = recorded.filter((p) => typeof p.guide === 'string');
  const texts = recorded.filter((p) => typeof p.text === 'string');
  assert.equal(guides.length, 1);
  assert.equal(guides[0].guide, seen[0].rules);
  assert.notEqual(guides[0].guide.indexOf('show_block.json'), -1, 'with the tools note agyRules adds');
  assert.deepEqual(
    texts.map((p) => `--print=${p.text}`),
    seen.map((s) => s.args.at(-1)),
  );
});

test('Antigravity records neither its rules nor its prompt when agy never started (ENOENT)', async () => {
  const root = tempDir('pb-prompt-agy-');
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const adapter = new AntigravityCliAdapter({ workRoot: join(root, 'work'), settingsFile: join(root, 'settings.json'), spawnImpl, env: {} });
  const recorded = [];
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, agyCtx(recorded)));
  assert.deepEqual(recorded, []);
});

test('Codex records the developer instructions its thread opens with, and the input turn/start sends', async () => {
  const seen = [];
  const adapter = new CodexAdapter({ workRoot: CODEX_ROOT, spawnImpl: () => fakeAppServer(seen) });
  const recorded = [];
  const ctx = {
    persona: { handle: 'critic', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'acceptEdits' },
    project: { folder: `${CODEX_ROOT}/project` },
    handles: ['critic'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
    prompt: (p) => recorded.push(p),
  };
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].guide, seen.find((x) => x.method === 'thread/start').params.developerInstructions);
  assert.equal(recorded[0].text, seen.find((x) => x.method === 'turn/start').params.input[0].text);
});

/** One Agent SDK turn on a recorded stream: the SDK yields the same messages as the CLI wrote. @param {string} name */
async function sdkTurn(name) {
  const lines = fixtureLines(name);
  const queried = [];
  const sdk = {
    query: (q) => {
      queried.push(q);
      return (async function* () {
        for (const l of lines) yield JSON.parse(l);
      })();
    },
  };
  const project = tempDir('pb-prompt-sdk-');
  const adapter = new AgentSdkAdapter({ sdk, workRoot: join(tempDir('pb-prompt-sdk-data-'), 'workspaces') });
  const recorded = [];
  const ctx = {
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { id: 'pe_alpha', handle: 'alpha', model: 'claude-sonnet-5-5', permissionMode: 'auto', folder: project, description: '', instructions: '' },
    project: { id: 'pr_one', folder: project },
    handles: ['alpha'],
    state: {},
    saveState: () => {},
    pathOf: () => null,
    text: () => {},
    activity: () => {},
    status: () => {},
    prompt: (p) => recorded.push(p),
  };
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx);
  return { recorded, queried };
}

test('the Agent SDK records the system prompt it appends and the prompt it queries with, once its CLI starts', async () => {
  // A turn recorded on claude 2.1.296 (tests/fixtures/claude-code/block.jsonl).
  const { recorded, queried } = await sdkTurn('block');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].guide, queried[0].options.systemPrompt.append);
  assert.equal(recorded[0].text, queried[0].prompt);
});

test('the Agent SDK records a query’s prompt once, though its CLI starts its loop again in the same turn', async () => {
  // Recorded turns whose CLI emitted system/init again: a background job finishing (2 inits), a monitor’s wakes (6).
  for (const name of ['background-done', 'monitor']) {
    const { recorded, queried } = await sdkTurn(name);
    assert.equal(queried.length, 1, `${name}: one query`);
    assert.equal(recorded.length, 1, `${name}: recorded ${recorded.length}`);
  }
});
