// #208: each Claude Code and Agent SDK persona remembers only what it learned. Claude Code keys its auto memory by
// working folder (~/.claude/projects/<project>/memory/), and every persona in a project runs in the project’s folder,
// so two personas, and the person’s own sessions there, shared one memory (reproduced with two real agents on
// 26 October 2026, #208). Each turn now passes `autoMemoryDirectory` in the `--settings` overlay (the SDK’s `settings`):
// a folder per persona and project in Postbox’s data folder, or on a host, in Postbox’s folder there.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { argOf, HOME, remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';

const DATA = '/tmp/pb-test-data';

// A recorded turn (tests/fixtures/claude-code/block.jsonl, claude 2.1.296), played by each fake below.
const LINES = fixtureLines('block');

/** A claude that plays the recorded turn; each run’s arguments are kept. */
function fakeSpawn() {
  const runs = [];
  const spawnImpl = (_bin, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    runs.push(args);
    setImmediate(() => {
      for (const l of LINES) child.stdout.write(`${l}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 5);
    });
    return child;
  };
  return { spawnImpl, runs };
}

const ctxFor = (persona, project) => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { model: 'claude-opus-5-5', permissionMode: 'ask', folder: '/tmp/pb-test-project', description: '', instructions: '', ...persona },
  project,
  handles: ['alpha', 'beta'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
});

const ALPHA = { id: 'pe_alpha', handle: 'alpha' };
const BETA = { id: 'pe_beta', handle: 'beta', usesHostSetup: false };
const PROJECT = { id: 'pr_one', folder: '/tmp/pb-test-project' };
const OTHER = { id: 'pr_two', folder: '/tmp/pb-test-other' };

test('#208: two Claude Code personas in one project each get a memory folder of their own, per project, in Postbox’s data folder', async () => {
  const { spawnImpl, runs } = fakeSpawn();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: `${DATA}/workspaces`, memoryRoot: `${DATA}/memory`, spawnImpl });
  for (const [p, pr] of [
    [ALPHA, PROJECT],
    [BETA, PROJECT],
    [ALPHA, OTHER],
  ])
    await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctxFor(p, pr));
  const dirs = runs.map((args) => JSON.parse(argOf(args, '--settings')).autoMemoryDirectory);
  // Isolated (beta) and “Uses your setup” (alpha) alike: that setting is for tooling, not the person’s memory.
  assert.deepEqual(dirs, [`${DATA}/memory/pe_alpha/pr_one`, `${DATA}/memory/pe_beta/pr_one`, `${DATA}/memory/pe_alpha/pr_two`]);
});

test('#208: an Agent SDK persona gets its own memory folder too, in the SDK’s settings', async () => {
  const calls = [];
  const sdk = {
    query({ options }) {
      calls.push(options);
      return (async function* () {
        for (const l of LINES) yield JSON.parse(l);
      })();
    },
  };
  const adapter = new AgentSdkAdapter({ sdk, workRoot: `${DATA}/workspaces`, memoryRoot: `${DATA}/memory` });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctxFor(ALPHA, PROJECT));
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctxFor(BETA, PROJECT));
  assert.deepEqual(
    calls.map((o) => o.settings.autoMemoryDirectory),
    [`${DATA}/memory/pe_alpha/pr_one`, `${DATA}/memory/pe_beta/pr_one`],
  );
});

test('#208: on a host, the persona’s memory folder is in Postbox’s folder there, never a path on this computer', async () => {
  const d = createFakeDaemon({ lines: LINES });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: `${DATA}/workspaces`, memoryRoot: `${DATA}/memory` });
  const ctx = remoteCtx(d);
  ctx.persona = { ...ctx.persona, id: 'pe_alpha' };
  ctx.project = { ...ctx.project, id: 'pr_one' };
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx);
  const [start] = starts(d);
  assert.equal(JSON.parse(argOf(start.argv, '--settings')).autoMemoryDirectory, `${HOME}/.postbox-remote/memory/pe_alpha/pr_one`);
});
