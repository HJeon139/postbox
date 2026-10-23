import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter, liveControl, sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { CLAUDE_CODE_CAPABILITIES, ClaudeCodeAdapter, claudeArgs, forkPoint } from '../server/adapters/claude-code.mjs';
import { contextPercent, createStreamMapper, describePermission, describeTool, forkPointMissing, resultError } from '../server/adapters/claude-stream.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { MockAdapter } from '../server/adapters/mock.mjs';
import { deniedTools, OUTSIDE_TOOLS, PUBLISHING_TOOLS, REAL_BACKEND_TOOLS, TOOL_RULES, WRITE_TOOLS } from '../server/adapters/setup.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

// Streams recorded from real Claude Code turns (claude 2.1.296, claude-opus-5-5), with local paths removed.
const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** A turn context that records what the adapter did. */
function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], status: [], compaction: [], denied: [], saved: {} };
  const abort = new AbortController();
  const ctx = {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: '/tmp/pb-test-coder', description: '', instructions: '' },
    project: null,
    handles: ['coder', 'critic'],
    state: {},
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: (s) => calls.status.push(s),
    compaction: (c) => calls.compaction.push(c),
    denied: (d) => calls.denied.push(d),
    ...over,
  };
  return ctx;
}

const replay = (name, opts) => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => 1000, ...opts });
  for (const e of fixture(name)) m.push(e);
  return { ctx, m };
};

test('a recorded turn that shows a block: the reply text, and no activity for Postbox’s own tools', () => {
  const { ctx, m } = replay('block');
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  assert.deepEqual(ctx.calls.activity, [], 'ToolSearch and show_block appear as what they make, not as steps');
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'Showing a block'));
  assert.equal(resultError(m.result), null);
  assert.equal(m.contextWindow, 1_000_000, 'the window comes from the result');
  // The first request assumed 200K; the result’s real window corrects the ring.
  const last = ctx.calls.status.filter((s) => typeof s.ctx === 'number').at(-1);
  assert.ok(last.ctx < 10, `context should read a few percent of 1M, got ${last.ctx}`);
});

test('a recorded command that you allowed: one step, running then done, labeled by its description', () => {
  const { ctx } = replay('permission-allow');
  const steps = ctx.calls.activity;
  assert.equal(steps[0].label, 'Running a command', 'the name arrives before the input');
  assert.equal(steps.at(-1).label, 'Write hello to a new file and show it');
  assert.equal(steps.at(-1).state, 'done');
  assert.match(ctx.calls.text, /^I ran `echo hello > hello\.txt`/);
});

test('a recorded command that you denied: the step fails, and the agent says what happened', () => {
  const { ctx } = replay('permission-deny');
  assert.equal(ctx.calls.activity.at(-1).state, 'failed');
  assert.match(ctx.calls.text, /didn’t allow/);
});

test('text blocks separated by a tool call get a paragraph break', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx);
  const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  m.push(ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10 } } }));
  m.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  m.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking.' } }));
  m.push(ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } }));
  m.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a/b/notes.md"}' } }));
  m.push(ev({ type: 'content_block_stop', index: 1 }));
  m.push({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } });
  m.push(ev({ type: 'message_start', message: { id: 'm2', usage: { input_tokens: 10 } } }));
  m.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  m.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } }));
  assert.equal(ctx.calls.text, 'Looking.\n\nFound it.');
  assert.deepEqual(
    ctx.calls.activity.map((a) => [a.label, a.state]),
    [
      ['Reading a file', 'running'],
      ['Read notes.md', 'running'],
      ['Read notes.md', 'done'],
    ],
  );
});

test('a subagent gets its own ring, which goes when its task ends', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx);
  m.push({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'Index the shelf', subagent_type: 'indexer' } }] },
  });
  m.push({ type: 'stream_event', parent_tool_use_id: 'task1', event: { type: 'message_start', message: { usage: { input_tokens: 20000 } } } });
  m.push({ type: 'stream_event', parent_tool_use_id: 'task1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  const subs = ctx.calls.status.filter((s) => s.subagents).at(-1).subagents;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, 'indexer');
  assert.equal(subs[0].state, 'gen');
  assert.equal(subs[0].ctx, 10);
  assert.equal(ctx.calls.text, '', 'a subagent’s text isn’t the agent’s reply');
  m.push({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'task1', content: 'done' }] } });
  assert.deepEqual(ctx.calls.status.filter((s) => s.subagents).at(-1).subagents, []);
});

test('a compaction is reported with how much there was before', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { contextWindow: 1_000_000 });
  m.push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 800_000 } });
  assert.equal(ctx.calls.compaction[0].total, 800_000);
  assert.ok(ctx.calls.compaction[0].kept < 800_000);
});

test('failures read as sentences', () => {
  assert.equal(resultError(null), 'Claude Code ended without finishing the turn.');
  assert.match(resultError({ subtype: 'error_max_turns', is_error: true }), /turn limit/);
  assert.equal(resultError({ subtype: 'success', is_error: true, result: 'API Error: overloaded' }), 'API Error: overloaded');
});

test('labels and permission cards say what a tool does', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'Ran npm test');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), 'Searched for “TODO”');
  assert.equal(describeTool('mcp__github__list_issues', { repo: 'x' }), 'list issues (github)');
  assert.deepEqual(describePermission('Bash', { command: 'rm -rf build', description: 'Clean the build' }), {
    summary: 'run a command: Clean the build',
    detail: 'rm -rf build',
  });
  assert.equal(describePermission('Write', { file_path: '/a/b/c.md' }).summary, 'write c.md');
  assert.equal(describePermission('mcp__github__create_issue', {}).summary, 'use create issue from github');
  assert.equal(contextPercent({ input_tokens: 1, cache_read_input_tokens: 49_999 }, 200_000), 25);
});

test('Claude Code says how it runs on a remote host; the Agent SDK and the mock can’t', () => {
  // Only the remote shape: left out, the rest reads as forking, reading rules and Claude’s models (adapter.mjs).
  assert.deepEqual(CLAUDE_CODE_CAPABILITIES, {
    remote: {
      stdin: 'file',
      env: [],
      server: 'mcp-config',
      work: 'events',
      signInError: { type: 'result', is_error: true, error: 'authentication_failed' },
    },
  });
  assert.equal(new ClaudeCodeAdapter({ workRoot: '/tmp/pb-test-work' }).capabilities, CLAUDE_CODE_CAPABILITIES);
  assert.equal(new AgentSdkAdapter({ sdk: {}, workRoot: '/tmp/pb-test-work' }).capabilities?.remote, undefined, 'it runs in Postbox’s process');
  assert.equal(new MockAdapter().capabilities?.remote, undefined);
  // It survives /api/state, which serves capabilities as JSON (server/index.mjs, config.backends).
  assert.deepEqual(JSON.parse(JSON.stringify(CLAUDE_CODE_CAPABILITIES)), CLAUDE_CODE_CAPABILITIES);
});

test('CLI arguments follow the persona’s permission mode and the session', () => {
  const base = { sessionId: 'abc', mcpUrl: 'http://x/mcp?session=1', guide: 'G' };
  const auto = claudeArgs({ ...base, persona: { model: 'mock' }, resume: false });
  assert.deepEqual(auto.slice(auto.indexOf('--permission-mode'), auto.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto'], 'auto is the default');
  assert.ok(auto.includes('--permission-prompt-tool'), 'what auto mode can’t decide comes to you');
  const ask = claudeArgs({ ...base, persona: { permissionMode: 'ask', model: 'mock' }, resume: false });
  assert.deepEqual(ask.slice(ask.indexOf('--model'), ask.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.ok(ask.includes('--session-id') && !ask.includes('--resume'));
  assert.deepEqual(ask.slice(ask.indexOf('--permission-mode'), ask.indexOf('--permission-mode') + 2), ['--permission-mode', 'manual']);
  assert.ok(ask.includes('--permission-prompt-tool'));
  assert.equal(JSON.parse(ask[ask.indexOf('--mcp-config') + 1]).mcpServers.postbox.url, 'http://x/mcp?session=1');
  const edits = claudeArgs({ ...base, persona: { permissionMode: 'acceptEdits', model: 'claude-sonnet-5-5' }, resume: true, addDirs: ['/p'] });
  assert.ok(edits.includes('--resume') && edits.includes('acceptEdits') && edits.includes('--permission-prompt-tool'));
  assert.deepEqual(edits.slice(edits.indexOf('--add-dir'), edits.indexOf('--add-dir') + 2), ['--add-dir', '/p']);
  const bypass = claudeArgs({ ...base, persona: { permissionMode: 'bypass' }, resume: false });
  assert.ok(bypass.includes('bypassPermissions') && !bypass.includes('--permission-prompt-tool'));
});

test('messages are written to the agent as plain text it can act on', () => {
  assert.equal(
    formatMessage({ kind: 'event', event: { blockId: 'b1', action: 'choose', values: { selected: ['tea'] } } }),
    '[Postbox] The person acted in block “b1”: choose\n{"selected":["tea"]}',
  );
  // The revision answered (#123), so an approval of revision 2 doesn’t read like one of revision 4.
  assert.equal(
    formatMessage({ kind: 'event', event: { blockId: 'b1', revision: 2, action: 'submit', values: { verdict: 'approve', comments: [] } } }),
    '[Postbox] The person acted in block “b1” (revision 2): submit\n{"verdict":"approve","comments":[]}',
  );
  assert.match(
    formatMessage({ kind: 'user', text: 'Look', attachments: [{ kind: 'file', name: 'a.png', type: 'image/png' }] }, () => '/blobs/ab/abc'),
    /- a\.png \(image\/png\): \/blobs\/ab\/abc/,
  );
});

/** A stand-in for spawn() that plays a recorded stream. */
function fakeSpawn(lines, { code = 0, stderr = '' } = {}) {
  const runs = [];
  const spawnImpl = (bin, args, opts) => {
    // A function plays a different run each time: (index) => { lines, code?, stderr? }.
    const play = typeof lines === 'function' ? { code: 0, stderr: '', ...lines(runs.length) } : { lines, code, stderr };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = [];
    child.kill = (sig) => {
      child.killed.push(sig);
      setImmediate(() => {
        child.stdout.end();
        child.emit('close', null);
      });
    };
    runs.push({ bin, args, opts, child });
    setImmediate(() => {
      if (play.lines === 'hang') return;
      for (const l of play.lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      if (play.stderr) child.stderr.write(play.stderr);
      child.stdout.end();
      setTimeout(() => child.emit('close', play.code), 10);
    });
    return child;
  };
  return { spawnImpl, runs };
}

test('the adapter runs a turn, remembers the Claude Code session, and resumes it next time', async () => {
  const { spawnImpl, runs } = fakeSpawn(fixture('block'));
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  const first = fixture('block')[0].session_id;
  assert.equal(ctx.calls.saved.claudeSessionId, first);
  assert.equal(ctx.calls.saved.contextWindow, 1_000_000);
  assert.ok(runs[0].args.includes('--session-id'));
  assert.equal(runs[0].opts.cwd, '/tmp/pb-test-coder');
  const again = fakeCtx({ state: { ...ctx.calls.saved } });
  await adapter.deliver({}, { kind: 'user', text: 'Again' }, again);
  assert.deepEqual(runs[1].args.slice(runs[1].args.indexOf('--resume'), runs[1].args.indexOf('--resume') + 2), ['--resume', first]);
});

test('Stop interrupts the CLI and ends the turn quietly', async () => {
  const { spawnImpl, runs } = fakeSpawn('hang');
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const ctx = fakeCtx();
  const done = adapter.deliver({}, { kind: 'user', text: 'Long job' }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  ctx.abort.abort();
  await done;
  assert.deepEqual(runs[0].child.killed, ['SIGINT']);
});

test('a CLI that fails without a result shows why', async () => {
  const { spawnImpl } = fakeSpawn([], { code: 1, stderr: 'Error: Invalid model name\n' });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, fakeCtx()), /exited with code 1: Error: Invalid model name/);
});

test('a folder the agent can’t work in fails its turn naming the folder, not as a missing CLI, on every backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-folder-'));
  try {
    // A folder inside a file can’t be made.
    await writeFile(join(root, 'file'), '');
    const folder = join(root, 'file', 'project');
    const runs = [];
    // Node’s spawn fails as ENOENT when its cwd is missing, the same code as a missing binary.
    const spawnImpl = (cmd, _args, opts) => {
      runs.push(opts.cwd);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1 });
      setTimeout(() => child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })), 1);
      return child;
    };
    const ctx = fakeCtx({ persona: { ...fakeCtx().persona, folder } });
    const turn = new ClaudeCodeAdapter({ bin: 'claude', workRoot: root, spawnImpl }).deliver({}, { kind: 'user', text: 'Hi' }, ctx);
    await assert.rejects(turn, (e) => {
      assert.match(e.message, /couldn’t open the folder .*file\/project for @coder: ENOTDIR/);
      assert.doesNotMatch(e.message, /isn’t installed/);
      return true;
    });
    assert.deepEqual(runs, [], 'nothing was started in a folder that isn’t there');
    const adapters = [
      new ClaudeCodeAdapter({ bin: 'claude', workRoot: root, spawnImpl }),
      new AgentSdkAdapter({ sdk: { query() {} }, workRoot: root }),
      new KiroCliAdapter({ bin: 'kiro-cli', workRoot: root, isolatedHome: root, spawnImpl }),
      new AntigravityCliAdapter({ bin: 'agy', workRoot: root, settingsFile: join(root, 'agy.json'), spawnImpl }),
      new CodexAdapter({ bin: 'codex', workRoot: root, spawnImpl }),
    ];
    for (const a of adapters) await assert.rejects(a.folderFor({ handle: 'coder', folder }, null), /couldn’t open the folder/, a.name);
  } finally {
    await rm(root, { recursive: true });
  }
});

// ── Agent SDK ────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for the SDK’s query() that replays a recorded stream and keeps the options it got. A function
 * plays a different run each time: (index) => { lines, throws? }, where throws is an error raised at the end.
 */
function fakeSdk(lines) {
  const calls = [];
  return {
    calls,
    query({ prompt, options }) {
      const play = typeof lines === 'function' ? lines(calls.length) : { lines };
      calls.push({ prompt, options });
      return (async function* () {
        for (const l of play.lines) yield l;
        if (play.throws) throw play.throws;
      })();
    },
  };
}

test('the Agent SDK adapter passes the mode explicitly, loads Postbox’s tools up front, and resumes', async () => {
  const sdk = fakeSdk(fixture('block'));
  const adapter = new AgentSdkAdapter({ sdk, workRoot: '/tmp/pb-test-work' });
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  const o = sdk.calls[0].options;
  assert.equal(o.permissionMode, 'default', 'this persona asks');
  assert.equal(typeof o.canUseTool, 'function');
  assert.equal(
    sdkOptions({ persona: {}, cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() }).permissionMode,
    'auto',
  );
  assert.equal(o.mcpServers.postbox.alwaysLoad, true);
  assert.equal(o.systemPrompt.preset, 'claude_code');
  assert.match(o.systemPrompt.append, /You are @coder/);
  assert.equal(o.model, 'claude-opus-5-5');
  assert.ok(o.sessionId && !o.resume);
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  await adapter.deliver({}, { kind: 'user', text: 'Again' }, fakeCtx({ state: { ...ctx.calls.saved } }));
  assert.equal(sdk.calls[1].options.resume, ctx.calls.saved.sdkSessionId);
  const bypass = sdkOptions({
    persona: { permissionMode: 'bypass' },
    cwd: '/w',
    sessionId: 's',
    resume: false,
    mcpUrl: 'u',
    guide: 'g',
    abortController: new AbortController(),
  });
  assert.equal(bypass.permissionMode, 'bypassPermissions');
  assert.equal(bypass.allowDangerouslySkipPermissions, true);
  assert.equal(bypass.canUseTool, undefined);
});

test('the Agent SDK’s canUseTool allows Postbox’s tools and asks you about the rest', async () => {
  const sdk = fakeSdk(fixture('block'));
  const asked = [];
  const ctx = fakeCtx({
    askPermission: async (req) => {
      asked.push(req);
      return { allow: false, message: 'No.' };
    },
  });
  await new AgentSdkAdapter({ sdk, workRoot: '/tmp/pb-test-work' }).deliver({}, { kind: 'user', text: 'x' }, ctx);
  const can = sdk.calls[0].options.canUseTool;
  assert.deepEqual(await can('mcp__postbox__show_block', { block: {} }), { behavior: 'allow', updatedInput: { block: {} } });
  assert.deepEqual(await can('Bash', { command: 'rm -rf /', description: 'Wipe' }), { behavior: 'deny', message: 'No.' });
  assert.deepEqual(asked, [
    {
      tool: 'Bash',
      summary: 'run a command: Wipe',
      detail: 'rm -rf /',
      input: { command: 'rm -rf /', description: 'Wipe' },
      suggestions: [],
      suppressAlways: false,
      agentId: null,
    },
  ]);
});

test('#66: canUseTool passes the prompt’s suggestions and subagent, and returns your edit and Always allow', async () => {
  const sdk = fakeSdk(fixture('block'));
  const asked = [];
  const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
  const ctx = fakeCtx({
    askPermission: async (req) => {
      asked.push(req);
      return { allow: true, updatedInput: { command: 'npm test -- --ci' }, updatedPermissions: rules };
    },
  });
  await new AgentSdkAdapter({ sdk, workRoot: '/tmp/pb-test-work' }).deliver({}, { kind: 'user', text: 'x' }, ctx);
  const can = sdk.calls[0].options.canUseTool;
  const answer = await can(
    'Bash',
    { command: 'npm test' },
    { suggestions: rules, agentID: 'task-1', toolUseID: 'toolu_1', signal: new AbortController().signal },
  );
  assert.deepEqual(answer, { behavior: 'allow', updatedInput: { command: 'npm test -- --ci' }, updatedPermissions: rules });
  assert.deepEqual(asked[0].suggestions, rules);
  assert.equal(asked[0].agentId, 'task-1');
  assert.equal(asked[0].toolUseId, 'toolu_1');
});

// ── Attached Claude Code sessions ─────────────────────────────────────────────────────────

const line = (e) => `${JSON.stringify(e)}\n`;
const typed = (text) => ({ type: 'user', turnOrigin: 'human', cwd: '/work/site', message: { role: 'user', content: text } });
const said = (content, stop = null) => ({ type: 'assistant', cwd: '/work/site', message: { role: 'assistant', content, stop_reason: stop } });
const result = (id, is_error = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error }] },
});

async function attachSetup() {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../server/store.mjs');
  const { Runtime } = await import('../server/runtime.mjs');
  const { AdapterRegistry } = await import('../server/adapters/adapter.mjs');
  const root = await mkdtemp(join(tmpdir(), 'pb-cc-'));
  await mkdir(join(root, '-work-site'));
  const id = '11111111-2222-3333-4444-555555555555';
  const file = join(root, '-work-site', `${id}.jsonl`);
  await writeFile(
    file,
    [
      line(typed('<command-name>/clear</command-name>')),
      line(typed('Fix the header on mobile')),
      line(said([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/site/header.css' } }])),
      line(result('t1')),
      line(said([{ type: 'text', text: 'Fixed: the header wraps now.' }], 'end_turn')),
    ].join(''),
  );
  const store = new Store(null);
  const turns = [];
  const adapter = { name: 'claude-code', deliver: async (_se, message) => turns.push(message) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], stats: () => ({}) },
    config: { origin: 'http://x', imageOrigins: [], claudeProjectsRoot: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  return { rt, store, root, id, file, turns };
}

test('recent Claude Code sessions are listed with their folder and first prompt', async () => {
  const { listClaudeSessions } = await import('../server/adapters/terminal-mirror.mjs');
  const { root, id } = await attachSetup();
  const [s] = await listClaudeSessions({ root });
  assert.equal(s.id, id);
  assert.equal(s.cwd, '/work/site');
  assert.equal(s.title, 'Fix the header on mobile', 'command wrappers aren’t prompts');
});

test('attaching a session brings its recent history and works in its folder', async () => {
  const { rt, store, id } = await attachSetup();
  const { threadId, personaId, sessionId } = await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
  rt.stopMirrors();
  assert.equal(store.state.personas[personaId].handle, 'site');
  assert.equal(store.state.personas[personaId].folder, '/work/site');
  assert.equal(store.state.sessions[sessionId].backendState.claudeSessionId, id);
  const items = store.items(threadId);
  assert.deepEqual(
    items.map((i) => [i.kind, i.via ?? null]),
    [
      ['user', 'terminal'],
      ['agent', 'terminal'],
      ['system', null],
    ],
  );
  assert.equal(items[1].text, 'Fixed: the header wraps now.');
  assert.deepEqual(
    items[1].activity.steps.map((s) => [s.label, s.state]),
    [['Read header.css', 'done']],
  );
  await assert.rejects(rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' }), /already attached/);
});

test('turns typed in the terminal are mirrored; Postbox’s own turns aren’t shown twice', async () => {
  const { appendFile } = await import('node:fs/promises');
  const { rt, store, id, file } = await attachSetup();
  const { threadId, sessionId } = await rt.attachClaudeSession({ claudeSessionId: id, projectId: 'p1' });
  rt.stopMirrors();
  rt.mirror(sessionId);
  clearInterval(rt.mirrors.get(sessionId).timer);
  const before = store.items(threadId).length;
  await appendFile(file, line(typed('Now the footer')) + line(said([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }])));
  rt.pollMirror(sessionId);
  assert.equal(store.state.sessions[sessionId].state, 'tool');
  await appendFile(file, line(result('t2')) + line(said([{ type: 'text', text: 'Footer done.' }], 'end_turn')));
  rt.pollMirror(sessionId);
  const added = store.items(threadId).slice(before);
  assert.deepEqual(
    added.map((i) => [i.kind, i.text]),
    [
      ['user', 'Now the footer'],
      ['agent', 'Footer done.'],
    ],
  );
  assert.deepEqual(
    added[1].activity.steps.map((s) => s.state),
    ['done'],
  );
  assert.equal(store.state.sessions[sessionId].state, 'idle');
  // A Postbox turn writes to the same file; those lines are skipped.
  rt.turns.set(sessionId, { sessionId });
  await appendFile(file, line({ ...typed('From Postbox'), turnOrigin: 'sdk' }) + line(said([{ type: 'text', text: 'Hi from Postbox.' }], 'end_turn')));
  rt.pollMirror(sessionId);
  rt.turns.delete(sessionId);
  rt.mirrors.get(sessionId).tail.skipToEnd();
  rt.pollMirror(sessionId);
  assert.equal(store.items(threadId).length, before + 2);
});

// ── Forks for topic threads ──────────────────────────────────────────────────────────────

test('a topic thread’s first turn forks the Claude Code session at its checkpoint, then keeps its own', async () => {
  const { spawnImpl, runs } = fakeSpawn(fixture('block'));
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const marks = [];
  const ctx = fakeCtx({ state: { fork: { claudeSessionId: 'conv-1', uuid: 'msg-9' } }, checkpoint: (c) => marks.push(c) });
  await adapter.deliver({}, { kind: 'user', text: 'Why?', context: ['[Postbox] This is a topic thread.'] }, ctx);
  const a = runs[0].args;
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 5), ['--resume', 'conv-1', '--fork-session', '--resume-session-at', 'msg-9']);
  assert.ok(!a.includes('--session-id'));
  assert.equal(ctx.calls.saved.claudeSessionId, fixture('block')[0].session_id, 'the fork’s own id, from init');
  assert.equal(ctx.calls.saved.fork, null);
  const last = fixture('block')
    .filter((e) => e.type === 'assistant')
    .at(-1).uuid;
  assert.deepEqual(marks, [{ claudeSessionId: fixture('block')[0].session_id, uuid: last }]);
  assert.match(runs[0].child.stdin.read().toString(), /^\[Postbox\] This is a topic thread\.\n\nWhy\?/);
});

test('fork points: a checkpoint, else the latest point of the session it forks', () => {
  assert.deepEqual(forkPoint({ fork: { claudeSessionId: 'a', uuid: 'u' } }), { claudeSessionId: 'a', uuid: 'u' });
  assert.deepEqual(forkPoint({ forkFrom: { claudeSessionId: 'b' } }), { claudeSessionId: 'b' });
  assert.equal(forkPoint({}), null);
  const o = sdkOptions({
    persona: {},
    cwd: '/w',
    sessionId: 's',
    resume: false,
    mcpUrl: 'u',
    guide: 'g',
    abortController: new AbortController(),
    fork: { sdkSessionId: 'conv', uuid: 'm1' },
  });
  assert.deepEqual([o.resume, o.forkSession, o.resumeSessionAt, o.sessionId], ['conv', true, 'm1', undefined]);
});

test('recorded refusals (a deny rule and the mode), for the agent and its subagent, each become one refusal', () => {
  const { ctx } = replay('denials');
  const d = ctx.calls.denied;
  assert.deepEqual(
    d.map((x) => [x.tool, x.who, x.reasonType]),
    [
      ['Bash', null, 'subcommandResults'],
      ['WebFetch', null, 'mode'],
      ['Bash', 'general-purpose', 'subcommandResults'],
      ['WebFetch', 'general-purpose', 'mode'],
    ],
  );
  assert.equal(d[0].input.command, 'rm copy.txt');
  assert.equal(d[0].label, 'Delete copy.txt');
  assert.match(d[1].reason, /don't ask mode\.$/, 'only the first sentence of the reason');
  // Each refused step is marked refused in the list, and the subagent’s steps are there under its name.
  const last = new Map(ctx.calls.activity.map((s) => [s.id, s]));
  const refused = [...last.values()].filter((s) => s.state === 'denied');
  assert.equal(refused.length, 4);
  assert.ok(refused.some((s) => s.who === 'general-purpose' && /copy\.txt/.test(s.label)));
});

test('a call you declined on a permission card isn’t reported again as a refusal', () => {
  const { ctx } = replay('permission-deny');
  assert.equal(ctx.calls.denied.length, 0, 'the result lists it, but the tool’s error is Postbox’s own answer');
  assert.equal(ctx.calls.activity.at(-1).state, 'failed');
});

test('summarized thinking shows as a glimpse while it streams, and each thought is a step', () => {
  let t = 0;
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => (t += 1000) });
  for (const e of fixture('thinking-subagent')) m.push(e);
  const glimpses = ctx.calls.status.map((s) => s.glimpse).filter(Boolean);
  assert.ok(
    glimpses.some((g) => /9\.9 is greater than 9\.11/.test(g)),
    JSON.stringify(glimpses),
  );
  const thoughts = ctx.calls.activity.filter((s) => s.kind === 'thought');
  assert.equal(thoughts.length, 2);
  assert.match(thoughts[0].label, /^9\.9 is greater than 9\.11/);
  // The subagent’s thinking is a thought of its own, under its name (#73), and moves its ring’s “doing” line, labeled
  // as thinking; its text never joins the reply.
  assert.equal(thoughts[1].who, 'general-purpose');
  assert.match(thoughts[1].detail, /straightforward question/);
  assert.ok(ctx.calls.status.some((s) => s.subagents?.some((x) => /straightforward/.test(x.doing) && x.thinking)));
  assert.doesNotMatch(ctx.calls.text, /straightforward question/);
});

test('real agents get readable thinking, subagent messages, and rules allowed once', () => {
  const args = claudeArgs({ persona: { model: 'mock' }, sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g', allowOnce: ['Bash(rm copy.txt)'] });
  assert.deepEqual(args.slice(args.indexOf('--thinking-display'), args.indexOf('--thinking-display') + 2), ['--thinking-display', 'summarized']);
  assert.ok(args.includes('--forward-subagent-text'));
  const allowed = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allowed, allowed + 3), ['--allowedTools', 'mcp__postbox', 'Bash(rm copy.txt)']);
  const opts = sdkOptions({
    persona: { model: 'mock' },
    cwd: '/w',
    sessionId: 's',
    resume: false,
    mcpUrl: 'u',
    guide: 'g',
    abortController: new AbortController(),
    allowOnce: ['WebFetch(domain:example.com)'],
  });
  assert.deepEqual(opts.allowedTools, ['WebFetch(domain:example.com)']);
  assert.deepEqual(opts.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(opts.forwardSubagentText, true);
});

test('#66: a recorded subagent’s permission prompt is named by its call, and the agent’s own isn’t', () => {
  // The CLI’s prompt tool sends only the call’s id (permission-prompts.json); the stream saw who made the call.
  const prompts = JSON.parse(readFileSync(new URL('fixtures/claude-code/permission-prompts.json', import.meta.url), 'utf8')).prompts;
  assert.ok(prompts.every((p) => !('permission_suggestions' in p) && !('agent_id' in p)));
  const { m } = replay('permission-subagent');
  assert.equal(m.who({ toolUseId: prompts[0].tool_use_id }), null);
  assert.equal(m.who({ toolUseId: prompts[1].tool_use_id }), 'general-purpose');
  // The SDK’s agent id is the task’s id, as for a refusal.
  assert.equal(m.who({ agentId: 'af66d9ea59ce3aaa6' }), 'general-purpose');
});

test('#66: a conversation’s rules and added folders reach both backends', () => {
  const rules = { allow: ['Bash(npm test:*)'], ask: ['Bash(git push:*)'], deny: ['WebFetch'] };
  const persona = { model: 'mock', tools: ['shell', 'web.fetch', 'agents.outside'], canPublish: true };
  const args = claudeArgs({ persona, sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', allowOnce: ['Bash(rm a)'], rules, addDirs: ['/data'] });
  const allowed = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allowed, allowed + 4), ['--allowedTools', 'mcp__postbox', 'Bash(rm a)', 'Bash(npm test:*)']);
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'WebFetch']);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]).permissions, { ask: [...WRITE_TOOLS, 'Bash(git push:*)'] });
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', '/data']);
  const opts = sdkOptions({
    persona,
    cwd: '/w',
    addDirs: ['/data'],
    sessionId: 's',
    resume: false,
    mcpUrl: 'u',
    guide: 'g',
    abortController: new AbortController(),
    rules,
  });
  assert.deepEqual(opts.allowedTools, ['Bash(npm test:*)']);
  assert.deepEqual(opts.disallowedTools, ['WebFetch']);
  assert.deepEqual(opts.settings.permissions, { ask: [...WRITE_TOOLS, 'Bash(git push:*)'] });
  assert.deepEqual(opts.additionalDirectories, ['/data']);
  // No conversation rules: only the asks for writes outside Postbox (#112), and none in bypass.
  const plain = claudeArgs({ persona, sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g' });
  assert.deepEqual(JSON.parse(plain[plain.indexOf('--settings') + 1]).permissions, { ask: WRITE_TOOLS });
  const bypass = claudeArgs({ persona: { ...persona, permissionMode: 'bypass' }, sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g' });
  assert.equal(JSON.parse(bypass[bypass.indexOf('--settings') + 1]).permissions, undefined);
});

test('#66: the SDK adapter’s live control changes a running query’s mode, and says when it couldn’t', async () => {
  const modes = [];
  const ok = liveControl({ setPermissionMode: async (m) => modes.push(m) });
  assert.equal(await ok.setPermissionMode('ask'), true);
  assert.deepEqual(modes, ['default']);
  // The SDK documents setPermissionMode for streaming input only; a string prompt may refuse it.
  const refused = liveControl({ setPermissionMode: async () => Promise.reject(new Error('Only available in streaming input mode')) });
  assert.equal(await refused.setPermissionMode('ask'), false);
  assert.equal(await liveControl({}).setPermissionMode('ask'), false);
});

test('a refusal only the result lists (a deny rule in settings) takes its reason from the tool’s error', () => {
  const ctx = fakeCtx();
  const m = createStreamMapper(ctx, { now: () => 1000 });
  m.push({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'rm a.txt', description: 'Delete a.txt' } }] },
  });
  const error = 'Permission to use Bash with command rm a.txt has been denied.';
  m.push({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu', is_error: true, content: error }] } });
  m.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu', tool_input: { command: 'rm a.txt' } }],
  });
  assert.equal(ctx.calls.denied.length, 1);
  assert.equal(ctx.calls.denied[0].reason, error);
  assert.equal(ctx.calls.activity.at(-1).state, 'denied');
});

// ── A fork whose branch point is gone (#61) ──────────────────────────────────────────────
// fork-point-missing.jsonl is the whole stdout of a real fork with a branch point that isn’t on the parent’s
// chain: `claude -p --output-format stream-json --include-partial-messages --verbose --model claude-haiku-5-5
// --resume <parent> --fork-session --resume-session-at 00000000-0000-4000-8000-000000000061` (claude 2.1.296).
// It exits with code 1, prints the same reason on stderr, and sends no init: only the result.

const MISSING_STDERR = 'No message found with message.uuid of: 00000000-0000-4000-8000-000000000061\n';

test('a failed turn says why, in Claude Code’s own words, bounded', () => {
  const [missing] = fixture('fork-point-missing');
  assert.equal(
    resultError(missing),
    'Claude Code hit an error while running the turn: No message found with message.uuid of: 00000000-0000-4000-8000-000000000061',
  );
  assert.equal(resultError({ subtype: 'error_during_execution', is_error: true }), 'Claude Code hit an error while running the turn.');
  const flood = resultError({ subtype: 'error_during_execution', is_error: true, errors: Array.from({ length: 50 }, () => 'x'.repeat(5000)) });
  assert.ok(flood.length < 1000, `bounded, got ${flood.length} characters`);
  assert.equal(resultError({ subtype: 'error_whatever', is_error: true, errors: ['Boom'] }), 'Claude Code reported a failure (error_whatever): Boom');
  assert.equal(forkPointMissing(missing), true);
  assert.equal(forkPointMissing({ subtype: 'error_during_execution', is_error: true, errors: ['Something else'] }), false);
  assert.equal(forkPointMissing(null, `Claude Code process exited with code 1: ${MISSING_STDERR}`), true);
  assert.equal(forkPointMissing(fixture('block').at(-1)), false);
});

test('a topic thread whose branch point is gone forks from the latest point once, and says so', async () => {
  const { spawnImpl, runs } = fakeSpawn((i) =>
    i === 0 ? { lines: fixture('fork-point-missing'), code: 1, stderr: MISSING_STDERR } : { lines: fixture('block') },
  );
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const marks = [];
  const ctx = fakeCtx({ state: { fork: { claudeSessionId: 'conv-1', uuid: 'msg-9' } }, checkpoint: (c) => marks.push(c) });
  await adapter.deliver({}, { kind: 'user', text: 'Why?', context: ['[Postbox] This is a topic thread.'] }, ctx);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].args.includes('--resume-session-at'));
  const a = runs[1].args;
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 3), ['--resume', 'conv-1', '--fork-session']);
  assert.ok(!a.includes('--resume-session-at') && !a.includes('msg-9'), 'the second run starts at the latest point');
  assert.match(
    runs[1].child.stdin.read().toString(),
    /^\[Postbox\] This thread couldn’t start at the message it branched from, so it starts from the conversation’s latest message\.\n\n\[Postbox\] This is a topic thread\.\n\nWhy\?/,
  );
  const own = fixture('block')[0].session_id;
  assert.equal(ctx.calls.saved.claudeSessionId, own, 'the fallback fork’s own id');
  assert.equal(ctx.calls.saved.fork, null);
  assert.deepEqual(
    marks.map((m) => m.claudeSessionId),
    [own],
    'only the run that worked leaves a checkpoint',
  );
});

test('a failed fallback leaves the fork without its uuid, so the next turn doesn’t go back to it', async () => {
  // The failed fork also sends an init here (the recorded one doesn’t): its session id mustn’t stick.
  const init = { type: 'system', subtype: 'init', session_id: 'failed-fork', model: 'claude-opus-5-5' };
  const broken = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Overloaded'] };
  const { spawnImpl, runs } = fakeSpawn((i) =>
    i === 0 ? { lines: [init, ...fixture('fork-point-missing')], code: 1, stderr: MISSING_STDERR } : { lines: [broken], code: 1 },
  );
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const marks = [];
  const ctx = fakeCtx({ state: { fork: { claudeSessionId: 'conv-1', uuid: 'msg-9' } }, checkpoint: (c) => marks.push(c) });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Why?' }, ctx), /hit an error while running the turn: Overloaded/);
  assert.equal(runs.length, 2, 'the fallback runs at most once');
  assert.equal(ctx.calls.saved.claudeSessionId, null);
  assert.deepEqual(ctx.calls.saved.fork, { claudeSessionId: 'conv-1' });
  assert.deepEqual(marks, []);
  const next = fakeSpawn(fixture('block'));
  await new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl: next.spawnImpl }).deliver(
    {},
    { kind: 'user', text: 'Again' },
    fakeCtx({ state: { ...ctx.calls.saved } }),
  );
  assert.ok(!next.runs[0].args.includes('--resume-session-at'));
});

test('a fork that succeeded keeps its reply, even if stderr mentions a missing message', async () => {
  const ok = fixture('block').at(-1);
  assert.equal(forkPointMissing(ok, MISSING_STDERR), false, 'a successful result is never a missing branch point');
  assert.equal(forkPointMissing(null, MISSING_STDERR), true, 'no result at all, and stderr says why');
  const { spawnImpl, runs } = fakeSpawn(fixture('block'), { stderr: MISSING_STDERR });
  const marks = [];
  const ctx = fakeCtx({ state: { fork: { claudeSessionId: 'conv-1', uuid: 'msg-9' } }, checkpoint: (c) => marks.push(c) });
  await new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl }).deliver({}, { kind: 'user', text: 'Why?' }, ctx);
  assert.equal(runs.length, 1, 'the turn isn’t run again');
  assert.equal(ctx.calls.text, 'Tea or coffee? Pick one above.');
  assert.equal(ctx.calls.saved.fork, null);
  assert.equal(marks.length, 1);
  const sdk = fakeSdk(() => ({ lines: fixture('block'), throws: new Error(`Claude Code process exited with code 0: ${MISSING_STDERR}`) }));
  await assert.rejects(
    new AgentSdkAdapter({ sdk, workRoot: '/tmp/pb-test-work' }).deliver(
      {},
      { kind: 'user', text: 'Why?' },
      fakeCtx({ state: { fork: { sdkSessionId: 'conv', uuid: 'm1' } } }),
    ),
    /The Agent SDK stopped/,
  );
  assert.equal(sdk.calls.length, 1, 'the SDK doesn’t run it again either');
});

test('the Agent SDK falls back the same way, and never resumes the failed fork', async () => {
  for (const throws of [null, new Error(`Claude Code process exited with code 1: ${MISSING_STDERR}`)]) {
    const init = { type: 'system', subtype: 'init', session_id: 'failed-fork', model: 'claude-opus-5-5' };
    const sdk = fakeSdk((i) => (i === 0 ? { lines: [init, ...fixture('fork-point-missing')], throws } : { lines: fixture('block') }));
    const marks = [];
    const ctx = fakeCtx({ state: { fork: { sdkSessionId: 'conv', uuid: 'm1' } }, checkpoint: (c) => marks.push(c) });
    await new AgentSdkAdapter({ sdk, workRoot: '/tmp/pb-test-work' }).deliver({}, { kind: 'user', text: 'Why?' }, ctx);
    assert.equal(sdk.calls.length, 2);
    assert.equal(sdk.calls[0].options.resumeSessionAt, 'm1');
    const o = sdk.calls[1].options;
    assert.deepEqual([o.resume, o.forkSession, o.resumeSessionAt], ['conv', true, undefined], 'not the failed fork, and not the bad uuid');
    assert.match(
      sdk.calls[1].prompt,
      /^\[Postbox\] This thread couldn’t start at the message it branched from, so it starts from the conversation’s latest message\.\n\nWhy\?$/,
    );
    const own = fixture('block')[0].session_id;
    assert.equal(ctx.calls.saved.sdkSessionId, own);
    assert.equal(ctx.calls.saved.fork, null);
    assert.deepEqual(
      marks.map((m) => m.sdkSessionId),
      [own],
    );
  }
});

// ── Your Claude Code setup (#57) ─────────────────────────────────────────────────────────
// host-setup-init.jsonl holds three real init events (claude 2.1.296, claude-haiku-5-5, outside the repo), cut
// down to their output style and tools, with the person’s private plugins and connectors left out:
//   1. claude -p with default setting sources;
//   2. with a project-local outputStyle of Concise, plus --setting-sources user,project,local and the deny list;
//   3. the same, plus --settings '{"outputStyle":"default"}'.

const base5 = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
const glob = (rule) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const deniedBy = (rules) => (tool) => rules.some((r) => glob(r).test(tool));

test('every combination of the setup choices reaches both backends', () => {
  const base = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
  const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  for (const usesHostSetup of [undefined, true, false]) {
    for (const canPublish of [undefined, false, true]) {
      // Every tool ticked, so only the publishing list is left to deny (#5 adds the unticked tools).
      const persona = { model: 'mock', usesHostSetup, canPublish, tools: Object.keys(TOOL_RULES) };
      const label = JSON.stringify({ usesHostSetup, canPublish });
      const args = claudeArgs({ ...base, persona });
      const sources = usesHostSetup === false ? 'project,local' : 'user,project,local';
      assert.equal(after(args, '--setting-sources'), sources, label);
      assert.deepEqual(JSON.parse(after(args, '--settings')), { outputStyle: 'default', permissions: { ask: WRITE_TOOLS } }, label);
      const o = sdkOptions({ ...sdkBase, persona });
      assert.deepEqual(o.settingSources, sources.split(','), label);
      assert.deepEqual(o.settings, { outputStyle: 'default', permissions: { ask: WRITE_TOOLS } }, label);
      if (canPublish === true) {
        assert.ok(!args.includes('--disallowedTools'), label);
        assert.equal(o.disallowedTools, undefined, label);
      } else {
        const i = args.indexOf('--disallowedTools');
        assert.deepEqual(args.slice(i + 1, i + 1 + PUBLISHING_TOOLS.length), PUBLISHING_TOOLS, label);
        assert.match(args[i + 1 + PUBLISHING_TOOLS.length], /^--/, 'the list ends at the next flag');
        assert.deepEqual(o.disallowedTools, PUBLISHING_TOOLS, label);
      }
    }
  }
});

test('the deny list matches what a real init offered that publishes, and nothing of Postbox’s or read-only', () => {
  const [own, concise, fixed] = fixture('host-setup-init');
  const denied = deniedBy(PUBLISHING_TOOLS);
  assert.deepEqual(own.tools.filter(denied), [
    'Artifact',
    'ArtifactComments',
    'ArtifactData',
    'PushNotification',
    'mcp__claude_ai_Claude_Docs__batch',
    'mcp__claude_ai_Claude_Docs__create',
    'mcp__claude_ai_Claude_Docs__update',
    'mcp__claude_ai_Google_Drive__copy_file',
    'mcp__claude_ai_Google_Drive__create_file',
    'mcp__claude_ai_Google_Drive__share_file',
    'mcp__claude_ai_Google_Drive__update_file',
  ]);
  // Claude Code itself removed exactly those, so the globs work as deny rules.
  assert.deepEqual(
    fixed.tools,
    own.tools.filter((t) => !denied(t)),
  );
  assert.ok(fixed.tools.includes('mcp__claude_ai_Google_Drive__search_files') && fixed.tools.includes('mcp__claude_ai_Claude_Docs__read'));
  // The flag-settings overlay beats the person’s own output style.
  assert.equal(concise.output_style, 'Concise');
  assert.equal(fixed.output_style, 'default');
  // Postbox’s own tools must never be denied: deny beats --allowedTools mcp__postbox.
  for (const t of TOOL_DEFS) assert.ok(!denied(`mcp__postbox__${t.name}`), t.name);
  // Connectors other people have, matched by the verb in their names: outward verbs on any server, and create
  // or upload only on claude.ai connectors.
  for (const t of [
    'mcp__slack__slack_send_message',
    'mcp__gmail__send_email',
    'mcp__x__post_message',
    'mcp__claude_ai_Linear__create_issue',
    'mcp__claude_ai_Slack__slack_create_canvas',
    'mcp__claude_ai_Box__upload_file',
  ])
    assert.ok(denied(t), t);
  for (const t of ['mcp__slack__slack_read_channel', 'mcp__github__list_issues', 'mcp__gmail__search_threads', 'mcp__notion__get_page'])
    assert.ok(!denied(t), t);
  // Local servers that create things on this computer publish nothing: deny would beat any allow rule for them.
  for (const t of [
    'mcp__memory__create_entities',
    'mcp__memory__create_relations',
    'mcp__filesystem__create_directory',
    'mcp__git__git_create_branch',
    'mcp__plugin_tools_db__create_table',
    'mcp__files__upload_to_tmp',
  ])
    assert.ok(!denied(t), t);
});

// ── #5: the Tools checklist reaches real backends ─────────────────────────────────────────

const allowedAfter = (args) => {
  const i = args.indexOf('--allowedTools');
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end);
};
const disallowed = (args) => {
  const i = args.indexOf('--disallowedTools');
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
};

test('#5: an unticked tool is denied in both backends; a ticked one is never an allow rule', () => {
  const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
  const all = Object.keys(TOOL_RULES);
  for (const id of all) {
    const ticked = { model: 'mock', canPublish: true, tools: all };
    const unticked = { model: 'mock', canPublish: true, tools: all.filter((t) => t !== id) };
    assert.deepEqual(disallowed(claudeArgs({ ...base5, persona: ticked })), [], `${id} ticked: nothing denied`);
    assert.equal(sdkOptions({ ...sdkBase, persona: ticked }).disallowedTools, undefined, id);
    assert.deepEqual(disallowed(claudeArgs({ ...base5, persona: unticked })), TOOL_RULES[id], `${id} unticked`);
    assert.deepEqual(sdkOptions({ ...sdkBase, persona: unticked }).disallowedTools, TOOL_RULES[id], id);
    // Ticked means “not denied”: the permission mode still asks, so no tool of the checklist is ever allowed.
    for (const persona of [ticked, unticked]) {
      assert.deepEqual(allowedAfter(claudeArgs({ ...base5, persona })), ['mcp__postbox'], id);
      assert.equal(sdkOptions({ ...sdkBase, persona }).allowedTools, undefined, id);
    }
  }
  assert.deepEqual(TOOL_RULES.shell, ['Bash', 'Monitor']);
  assert.deepEqual(TOOL_RULES['web.fetch'], ['WebFetch', 'WebSearch', 'Monitor']);
  assert.deepEqual(
    disallowed(claudeArgs({ ...base5, persona: { model: 'mock', canPublish: true, tools: ['agents.outside'] } })),
    ['Bash', 'Monitor', 'WebFetch', 'WebSearch'],
    'each rule once',
  );
});

test('#5: tools that act outside Postbox are denied by default, unless the persona allows them', () => {
  // A persona from before the id existed (no agents.outside), and the fresh install’s agent (no tools at all).
  for (const persona of [{ tools: ['shell', 'web.fetch'] }, { tools: [] }, {}]) {
    const denied = deniedTools(persona);
    for (const t of OUTSIDE_TOOLS) assert.ok(denied.includes(t), `${t} for ${JSON.stringify(persona)}`);
    assert.deepEqual(denied.slice(0, PUBLISHING_TOOLS.length), PUBLISHING_TOOLS, 'with the publishing list');
  }
  assert.deepEqual(OUTSIDE_TOOLS, ['SendMessage', 'ListAgents', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Workflow']);
  const allows = deniedTools({ tools: ['agents.outside', 'shell', 'web.fetch'] });
  assert.ok(!OUTSIDE_TOOLS.some((t) => allows.includes(t)));
  // The checklist offers the id, with a label, to real backends.
  assert.deepEqual(
    REAL_BACKEND_TOOLS.map(([id]) => id),
    ['agents.outside'],
  );
  for (const [id] of REAL_BACKEND_TOOLS) assert.ok(Object.hasOwn(TOOL_RULES, id), id);
});

test('#5: no deny rule matches a Postbox tool, and every rule names a tool a real init offered', () => {
  const every = deniedTools({ tools: [] });
  for (const t of TOOL_DEFS) assert.ok(!deniedBy(every)(`mcp__postbox__${t.name}`), t.name);
  const [mine, denied] = fixture('host-mcp-init');
  for (const t of Object.values(TOOL_RULES).flat()) assert.ok(mine.tools.includes(t), `${t} is a real tool name`);
  // The second recorded turn passed every rule: Claude Code removed them all, and only them.
  for (const t of Object.values(TOOL_RULES).flat()) assert.ok(!denied.tools.includes(t), `${t} is gone`);
  for (const t of ['Read', 'Edit', 'Write', 'Task', 'Skill', 'TaskStop', 'EnterWorktree']) assert.ok(denied.tools.includes(t), `${t} stays`);
});

// ── #60: model and effort ────────────────────────────────────────────────────────────────

test('#60: both backends always pass the model and the effort, with the defaults when a persona names none', () => {
  const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  for (const [persona, model, effort] of [
    [{ model: 'claude-sonnet-5-5', effort: 'high' }, 'claude-sonnet-5-5', 'high'],
    [{ model: 'claude-haiku-5-5', effort: 'max' }, 'claude-haiku-5-5', 'max'],
    // A persona from before effort existed, an unknown level, and the mock’s model.
    [{ model: 'claude-opus-5-5' }, 'claude-opus-5-5', 'medium'],
    [{ model: 'claude-opus-5-5', effort: 'ultra' }, 'claude-opus-5-5', 'medium'],
    [{ model: 'mock' }, 'claude-opus-5-5', 'medium'],
  ]) {
    const args = claudeArgs({ ...base5, persona });
    assert.deepEqual([after(args, '--model'), after(args, '--effort')], [model, effort], JSON.stringify(persona));
    const o = sdkOptions({ ...sdkBase, persona });
    assert.deepEqual([o.model, o.effort], [model, effort], JSON.stringify(persona));
  }
});

// model-effort.jsonl: a real turn (claude 2.1.296, outside the repo) with --model claude-sonnet-5-5 --effort high,
// asked to run `printenv CLAUDE_EFFORT`, which Claude Code sets to the turn’s effort. Its init is cut down to a few
// tools and Postbox’s server, with local paths removed. The stream reports the model, in init and in each
// assistant message, but not the effort.
test('#60: a recorded turn with --model and --effort reports the model that answered, and the effort it was started with', () => {
  const lines = fixture('model-effort');
  assert.equal(lines.find((e) => e.type === 'user').message.content[0].content, 'high', 'the flag set the effort');
  assert.ok(!('effort' in lines[0]), 'init doesn’t say the effort');
  const reported = [];
  const m = createStreamMapper(fakeCtx({ reported: (r) => reported.push(r) }), { effort: 'high' });
  for (const e of lines) m.push(e);
  assert.deepEqual(reported, [{ mcpServers: lines[0].mcp_servers, model: 'claude-sonnet-5-5', effort: 'high' }, { model: 'claude-sonnet-5-5' }]);
  // A different model answering (a fallback, say) is reported; Claude Code’s own “<synthetic>” messages aren’t.
  const fell = [];
  const m2 = createStreamMapper(fakeCtx({ reported: (r) => fell.push(r) }), { effort: 'high' });
  for (const e of lines) {
    m2.push(e.type === 'assistant' && e.message.content[0].type === 'text' ? { ...e, message: { ...e.message, model: 'claude-haiku-5-5' } } : e);
  }
  m2.push({ type: 'assistant', message: { model: '<synthetic>', content: [] } });
  assert.deepEqual(fell.at(-1), { model: 'claude-haiku-5-5' });
});
