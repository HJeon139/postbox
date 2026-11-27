// #1686, the reopened sweep: errors and output from tools and harnesses, which the person reads on a step or a failed
// turn and the agent in a note, cut by length only at a whole character (cutText). Each case puts an emoji across its
// site’s cut.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { exitError } from '../server/adapters/agy-errors.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { codexApproval } from '../server/adapters/codex-approval.mjs';
import { codexRefusal } from '../server/adapters/codex-thread.mjs';
import { reportDisplayError } from '../server/adapters/kiro-display-error.mjs';
import { kiroExitError } from '../server/adapters/kiro-errors.mjs';
import { POSTBOX_SERVER } from '../server/adapters/setup.mjs';
import { versionIn } from '../shared/cli-version.mjs';
import { settle, setup } from './blocks-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';
import { across, whole } from './text-cuts-fixture.mjs';

test('#1686 a CLI’s version, read from a first line with no x.y.z, is cut whole', () => {
  whole(versionIn(`${across(200)}\nmore`), 'the version');
});

test('#1686 why Kiro and Antigravity exited, from their stderr, is cut whole', () => {
  whole(kiroExitError(1, across(400)), 'Kiro’s exit');
  whole(exitError(1, across(400)), 'Antigravity’s exit');
});

test('#1686 Kiro’s display error and Codex’s refusal to start the turn are cut whole on their steps', () => {
  /** @type {any[]} */
  const steps = [];
  const ctx = { activity: (/** @type {any} */ s) => steps.push(s), saveState: () => {} };
  reportDisplayError(ctx, { message: across(400) });
  whole(steps[0]?.detail, 'Kiro’s error');
  const head = `required MCP servers failed to initialize: ${POSTBOX_SERVER}: `;
  codexRefusal(ctx, new Error(`${head}${across(400 - head.length)}`));
  whole(steps[1]?.detail, 'Codex’s refusal');
});

test('#1686 a Codex MCP server’s and tool’s names are cut whole on the card it asks for', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ req) => {
      asked.push(req);
      return { allow: false };
    },
  };
  const meta = { codex_approval_kind: 'mcp_tool_call', tool_name: across(80) };
  await codexApproval(ctx, { id: 1, method: 'mcpServer/elicitation/request', params: { serverName: across(80), _meta: meta } });
  await codexApproval(ctx, { id: 2, method: 'mcpServer/elicitation/request', params: { serverName: across(80), message: 'Say?' } });
  for (const req of asked) for (const k of ['tool', 'summary']) whole(req[k], `the card’s ${k}`);
});

test('#1686 why Claude Code exited without a result, from its stderr, is cut whole', async () => {
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    setImmediate(() => {
      child.stderr.end(across(400));
      child.stdout.end();
      setTimeout(() => child.emit('close', 1), 5);
    });
    return child;
  };
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-cuts-claude-work-'), spawnImpl });
  const ctx = {
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-cuts-claude-'), description: '', instructions: '' },
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
  };
  const err = await adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx).then(
    () => assert.fail('the turn failed'),
    (e) => e,
  );
  assert.match(err.message, /^Claude Code exited with code 1: x/);
  whole(err.message, 'the exit');
});

test('#1686 Mermaid’s error for a diagram the browser couldn’t draw reaches the agent cut whole', async () => {
  const { rt, store, t, adapter } = setup();
  adapter.next.push(async (c) => c.text('```mermaid\ngraph LR\nA-->B\n```'));
  rt.sendMessage(t.id, { text: 'draw it' });
  await settle(rt);
  const reply = store.items(t.id).findLast((i) => i.kind === 'agent');
  assert.equal(rt.diagramCheck(t.id, reply.id, { src: 'graph LR\nA-->B', error: { message: across(400), line: 2 } }).sent, true);
  await settle(rt);
  const told = JSON.stringify(adapter.calls.at(-1)?.message);
  assert.match(told, /xxxx/, 'the lint turn carries the error');
  // JSON.stringify writes a lone half as its escape.
  assert.doesNotMatch(told, /\\ud[89ab]/i, 'the error ends inside a character');
});
