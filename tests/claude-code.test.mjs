import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentSdkAdapter, sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { ClaudeCodeAdapter, claudeArgs, forkPoint } from '../server/adapters/claude-code.mjs';
import { contextPercent, createStreamMapper, describePermission, describeTool, resultError } from '../server/adapters/claude-stream.mjs';
import { formatMessage } from '../server/adapters/guide.mjs';

// Streams recorded from real Claude Code turns (claude 2.1.296, claude-opus-5-5), with local paths removed.
const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** A turn context that records what the adapter did. */
function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], status: [], compaction: [], saved: {} };
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
  assert.match(
    formatMessage({ kind: 'user', text: 'Look', attachments: [{ kind: 'file', name: 'a.png', type: 'image/png' }] }, () => '/blobs/ab/abc'),
    /- a\.png \(image\/png\): \/blobs\/ab\/abc/,
  );
});

/** A stand-in for spawn() that plays a recorded stream. */
function fakeSpawn(lines, { code = 0, stderr = '' } = {}) {
  const runs = [];
  const spawnImpl = (bin, args, opts) => {
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
      if (lines === 'hang') return;
      for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      setTimeout(() => child.emit('close', code), 10);
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

// ── Agent SDK ────────────────────────────────────────────────────────────────────────────

/** A stand-in for the SDK’s query() that replays a recorded stream and keeps the options it got. */
function fakeSdk(lines) {
  const calls = [];
  return {
    calls,
    query({ prompt, options }) {
      calls.push({ prompt, options });
      return (async function* () {
        for (const l of lines) yield l;
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
  assert.deepEqual(asked, [{ tool: 'Bash', summary: 'run a command: Wipe', detail: 'rm -rf /' }]);
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
