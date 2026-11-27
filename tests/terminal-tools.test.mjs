// #1712: every Claude Code turn Postbox starts, on this computer and on a host, names Postbox’s react in
// CLAUDE_CODE_TERMINAL_MCP_TOOLS, so a turn whose last call is a reaction may end with no text instead of being
// re-prompted for a line. The list is merged with the one the person or the host already set, never replaced
// (shared/terminal-tools.mjs). The local turn plays the recorded model-effort.jsonl (claude 2.1.296); the host turn
// runs against tests/fake-daemon.mjs and the in-process daemon of tests/remote-daemon-setup.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { claudeArgs, POSTBOX_REACT_TOOL } from '../server/adapters/claude-code-args.mjs';
import { POSTBOX_SERVER } from '../server/adapters/setup.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { TURN_FILES } from '../shared/remote-protocol.mjs';
import { TERMINAL_TOOLS_VAR, terminalToolsEnv, withTerminalTool } from '../shared/terminal-tools.mjs';
import { forbidden, remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { hello, setup, startMsg } from './remote-daemon-setup.mjs';
import { tempDir } from './temp-dirs.mjs';

const RECORDED = readFileSync(new URL('fixtures/claude-code/model-effort.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

/** A turn context whose callbacks do nothing, as tests/claude-code.test.mjs’s fakeCtx. */
const quietCtx = () => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-test-terminal-'), description: '', instructions: '' },
  project: null,
  handles: ['coder'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  compaction: () => {},
  denied: () => {},
});

/** A claude that records the options it was started with, plays the recorded turn, and exits 0. */
function recordingSpawn() {
  const seen = [];
  const spawnImpl = (_bin, _args, opts) => {
    seen.push(opts);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    setImmediate(() => {
      for (const l of RECORDED) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 5);
    });
    return child;
  };
  return { seen, spawnImpl };
}

/** The env of a local turn’s claude. */
async function localTurnEnv() {
  const { seen, spawnImpl } = recordingSpawn();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-test-terminal-work-'), spawnImpl });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, quietCtx());
  return seen[0].env;
}

/** Sets the variable in this process’s environment for one test, or unsets it. @param {any} t @param {string} [value] */
function inherit(t, value) {
  const before = process.env[TERMINAL_TOOLS_VAR];
  if (value === undefined) delete process.env[TERMINAL_TOOLS_VAR];
  else process.env[TERMINAL_TOOLS_VAR] = value;
  t.after(() => {
    if (before === undefined) delete process.env[TERMINAL_TOOLS_VAR];
    else process.env[TERMINAL_TOOLS_VAR] = before;
  });
}

test('#1712: Postbox’s react is named by the server Postbox registers, on this computer and on a host', () => {
  assert.equal(POSTBOX_REACT_TOOL, `mcp__${POSTBOX_SERVER}__react`);
  assert.ok(
    TOOL_DEFS.some((d) => d.name === 'react'),
    'Postbox’s server offers a tool named react',
  );
  const args = claudeArgs({ persona: {}, sessionId: 's', mcpUrl: 'http://x/mcp', guide: 'G', resume: false });
  const servers = Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers);
  assert.deepEqual(
    servers.map((s) => `mcp__${s}__react`),
    [POSTBOX_REACT_TOOL],
  );
});

test('#1712: a local Claude Code turn starts with Postbox’s react in its terminal tools, and the rest of the environment', async (t) => {
  inherit(t);
  const env = await localTurnEnv();
  assert.equal(env[TERMINAL_TOOLS_VAR], POSTBOX_REACT_TOOL);
  assert.equal(env.PATH, process.env.PATH, 'the rest of this process’s environment still goes');
});

test('#1712: a local turn keeps the terminal tools the person set, and appends Postbox’s react', async (t) => {
  inherit(t, 'mcp__other__react,mcp__notes__done');
  const env = await localTurnEnv();
  assert.equal(env[TERMINAL_TOOLS_VAR], `mcp__other__react,mcp__notes__done,${POSTBOX_REACT_TOOL}`);
});

test('#1712: a local turn doesn’t name Postbox’s react twice when the person’s list already has it', async (t) => {
  inherit(t, `mcp__other__react, ${POSTBOX_REACT_TOOL}`);
  const env = await localTurnEnv();
  assert.equal(env[TERMINAL_TOOLS_VAR], `mcp__other__react, ${POSTBOX_REACT_TOOL}`, 'the list as it was');
});

test('#1712: the merge keeps every name once, and the rest of the environment', () => {
  assert.equal(withTerminalTool(undefined, 'mcp__a__b'), 'mcp__a__b');
  assert.equal(withTerminalTool('', 'mcp__a__b'), 'mcp__a__b');
  assert.equal(withTerminalTool('mcp__x__y', 'mcp__a__b'), 'mcp__x__y,mcp__a__b');
  assert.equal(withTerminalTool('mcp__a__b,mcp__x__y', 'mcp__a__b'), 'mcp__a__b,mcp__x__y');
  assert.deepEqual(terminalToolsEnv({ HOME: '/h' }, 'mcp__a__b'), { HOME: '/h', [TERMINAL_TOOLS_VAR]: 'mcp__a__b' });
});

test('#1712: a turn on a host sends Postbox’s react as its terminal tools, by the name its shim registers', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  await adapter.deliver({}, { kind: 'user', text: 'Hi' }, remoteCtx(d));
  const [start] = starts(d);
  assert.equal(start.env[TERMINAL_TOOLS_VAR], POSTBOX_REACT_TOOL);
  const servers = JSON.parse(start.argv[start.argv.indexOf('--mcp-config') + 1]).mcpServers;
  assert.deepEqual(
    Object.entries(servers).map(([name, s]) => [`mcp__${name}__react`, s.type]),
    [[start.env[TERMINAL_TOOLS_VAR], 'stdio']],
    'the one server, the host’s shim, is the one the name points at',
  );
});

/** Starts turn t1 on an in-process daemon whose environment is `env`, and returns the env its start.json records. */
async function hostRecordEnv(env, sent) {
  const s = setup({ env: { PATH: '/usr/bin', ...env } });
  try {
    const c = await hello(s);
    c.send('start', startMsg('t1', { env: sent }));
    await c.msgs.next('started');
    return JSON.parse(readFileSync(s.p.turn('t1', TURN_FILES.start), 'utf8')).env;
  } finally {
    await s.done();
  }
}

test('#1712: the host’s daemon adds the name the laptop sends to the host’s own list, and doesn’t double it', async () => {
  const sent = { [TERMINAL_TOOLS_VAR]: POSTBOX_REACT_TOOL };
  assert.equal((await hostRecordEnv({}, sent))[TERMINAL_TOOLS_VAR], POSTBOX_REACT_TOOL);
  assert.equal((await hostRecordEnv({ [TERMINAL_TOOLS_VAR]: 'mcp__host__done' }, sent))[TERMINAL_TOOLS_VAR], `mcp__host__done,${POSTBOX_REACT_TOOL}`);
  const already = `${POSTBOX_REACT_TOOL},mcp__host__done`;
  assert.equal((await hostRecordEnv({ [TERMINAL_TOOLS_VAR]: already }, sent))[TERMINAL_TOOLS_VAR], already);
  // A start that doesn’t set the list leaves the host’s own to the runner, which inherits it.
  const none = await hostRecordEnv({ [TERMINAL_TOOLS_VAR]: 'mcp__host__done' }, { CLAUDE_CODE_ENTRYPOINT: 'postbox' });
  assert.equal(Object.hasOwn(none, TERMINAL_TOOLS_VAR), false);
});
