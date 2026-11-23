// Every backend tells its turn when its CLI’s process group outlived SIGKILL (ctx.unkilled, which stopTurn calls in
// server/adapters/process-group.mjs), so a run clock voids its timed run whichever backend the agent runs on (#1526).
// Each case drives the real adapter’s Stop on a fake CLI that exits on SIGINT while its group stays: the fake `kill`
// finds the group still there after SIGKILL. No real timer runs: mock timers stand in for setTimeout and setInterval,
// and each wait is on the event loop’s turns, with real time as its bound (tests/until-turns.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { AgentSdkAdapter } from '../server/adapters/agent-sdk.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';
import { untilTurns as until } from './until-turns.mjs';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
afterEach(() => mock.timers.reset());

/** A CLI that exits on Stop’s SIGINT, as its launcher does, while a process of its group is stuck: never gone. */
function stuckChild(pid) {
  const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.kill = () => true;
  child.exitNow = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', null, 'SIGINT');
    child.emit('close', null, 'SIGINT');
  };
  return child;
}

/** `kill` for a group that outlives SIGKILL: every signal lands, and signal 0 always finds the group there. */
const neverGone = () => true;

/** A turn’s context, with ctx.unkilled counting its calls. */
function turnCtx(persona) {
  const abort = new AbortController();
  const said = { unkilled: 0 };
  return {
    said,
    abort,
    ctx: {
      signal: abort.signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1&turn=t1',
      persona,
      project: null,
      handles: [persona.handle],
      state: {},
      text: () => {},
      activity: () => {},
      status: () => {},
      saveState: () => {},
      checkpoint: () => {},
      reported: () => {},
      control: () => {},
      job: () => {},
      usage: () => {},
      pathOf: () => null,
      unkilled: () => {
        said.unkilled++;
      },
    },
  };
}

/** Each backend: its adapter on a stuck CLI, and how its turn is started and its CLI made to exit. */
const BACKENDS = [
  {
    name: 'Claude Code',
    make(children) {
      return new ClaudeCodeAdapter({
        bin: 'claude',
        workRoot: tempDir('pb-unkilled-cc-'),
        spawnImpl: /** @type {any} */ (() => children[children.push(stuckChild(5101)) - 1]),
        kill: neverGone,
        listProcesses: async () => [],
      });
    },
    persona: { handle: 'dev', model: 'claude-opus-5-5', permissionMode: 'auto' },
  },
  {
    name: 'Agent SDK',
    make(children) {
      const sdk = {
        query({ options }) {
          return (async function* () {
            children.push(options.spawnClaudeCodeProcess({ command: 'claude', args: [], cwd: options.cwd, env: {}, signal: options.abortController.signal }));
            yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
            await new Promise((r) => options.abortController.signal.addEventListener('abort', r));
          })();
        },
      };
      return new AgentSdkAdapter({
        sdk,
        workRoot: tempDir('pb-unkilled-sdk-'),
        spawnImpl: /** @type {any} */ (() => stuckChild(5102)),
        kill: neverGone,
        listProcesses: async () => [],
      });
    },
    persona: { handle: 'sdk', model: 'claude-opus-5-5', permissionMode: 'auto' },
  },
  {
    name: 'Codex',
    make(children) {
      return new CodexAdapter({
        workRoot: CODEX_ROOT,
        spawnImpl: /** @type {any} */ (
          () => {
            const c = fakeAppServer([], { hold: true });
            Object.assign(c, { pid: 5103, kill: () => true });
            c.exitNow = () => c.emit('exit', null, 'SIGINT');
            return children[children.push(c) - 1];
          }
        ),
        kill: neverGone,
        listProcesses: async () => [],
      });
    },
    persona: { handle: 'gpt', model: 'gpt-5.6-terra' },
  },
  {
    name: 'Kiro',
    make(children) {
      const root = tempDir('pb-unkilled-kiro-');
      return new KiroCliAdapter({
        bin: 'kiro-cli',
        workRoot: join(root, 'work'),
        isolatedHome: join(root, 'home'),
        spawnImpl: /** @type {any} */ (() => children[children.push(stuckChild(5104)) - 1]),
        kill: neverGone,
        listProcesses: async () => [],
      });
    },
    persona: { handle: 'kiro', permissionMode: 'auto', usesHostSetup: false },
  },
  {
    name: 'Antigravity',
    make(children) {
      const root = tempDir('pb-unkilled-agy-');
      return new AntigravityCliAdapter({
        workRoot: join(root, 'work'),
        settingsFile: join(root, 'settings.json'),
        spawnImpl: /** @type {any} */ (() => children[children.push(stuckChild(5105)) - 1]),
        kill: neverGone,
        listProcesses: async () => [],
        env: {},
      });
    },
    persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [] },
  },
];

for (const b of BACKENDS)
  test(`${b.name}: Stop on a CLI whose group outlives SIGKILL tells the turn so (ctx.unkilled)`, async () => {
    const children = [];
    const adapter = b.make(children);
    const { ctx, abort, said } = turnCtx(b.persona);
    const turn = adapter.deliver({}, { kind: 'user', text: 'Work until stopped.' }, ctx).catch((e) => e);
    await until(() => children.length > 0, 'the CLI to start');
    abort.abort();
    children[0].exitNow();
    // Past the grace period’s SIGKILL and the wait after it (GRACE_MS + 5 s), one tick at a time.
    for (let i = 0; i < 100 && !said.unkilled; i++) {
      mock.timers.tick(100);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(said.unkilled, 1, 'the turn hears its CLI may still be working');
    mock.timers.tick(10_000);
    await turn;
  });
