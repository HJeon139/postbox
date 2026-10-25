import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  AGY_CAPABILITIES,
  AGY_DEFAULT_MODEL,
  ALLOW_POSTBOX,
  AntigravityCliAdapter,
  agyArgs,
  agyEffort,
  agyModel,
  agyPlugin,
  agyRules,
  allowPostbox,
  createAgyMapper,
  effortRun,
  excludeFile,
  excludePlugin,
  exitError,
  FolderQueue,
  modelIds,
  PLUGIN_DIR,
  refusalFollowUp,
} from '../server/adapters/antigravity-cli.mjs';
import { TOOL_DEFS } from '../server/mcp.mjs';

// Streams recorded from real Antigravity CLI turns (agy 1.4.5, gemini-3.8-flash), with local paths replaced. The
// MCP server they called listed Postbox’s own tools (server/mcp.mjs, TOOL_DEFS).
const fixture = (name) =>
  readFileSync(new URL(`fixtures/antigravity-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], status: [], reported: [], saved: {} };
  const abort = new AbortController();
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'gem', model: 'gemini-3.8-flash-high', permissionMode: 'ask', tools: [], description: '', instructions: '' },
    project: null,
    handles: ['gem', 'critic'],
    state: {},
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: (s) => calls.status.push(s),
    reported: (r) => calls.reported.push(r),
    ...over,
  };
}

const replay = (name, opts) => {
  const ctx = fakeCtx();
  const m = createAgyMapper(ctx, { now: () => 1000, ...opts });
  for (const e of fixture(name)) m.push(e);
  return { ctx, m };
};

test('the capabilities: resumes, can’t fork, reads no Claude Code rules, can’t deny tools or isolate, asks through permission_prompt', () => {
  assert.deepEqual({ ...AGY_CAPABILITIES }, { resume: true, fork: false, permissions: 'none', tools: 'none', isolation: false, promptTool: true });
  const a = new AntigravityCliAdapter({ workRoot: '/tmp/x', models: ['gemini-3.8-flash-high'] });
  assert.deepEqual(a.capabilities.models, ['gemini-3.8-flash-high']);
  assert.equal(new AntigravityCliAdapter({ workRoot: '/tmp/x' }).capabilities.models, undefined);
});

test('a recorded turn that shows a block: the reply, no step for Postbox’s tool or its schema, the conversation and the model', () => {
  const { ctx, m } = replay('block');
  assert.equal(ctx.calls.text, 'I showed a block asking “# Tea or coffee?”.\n');
  // The schema read before the call and show_block itself are both quiet.
  assert.deepEqual(ctx.calls.activity, []);
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'Showing a block'));
  assert.ok(ctx.calls.status.some((s) => s.state === 'gen'));
  // Each tool step is followed by thinking, which agy doesn’t report until it’s done.
  const after = ctx.calls.status.findIndex((s) => s.currentStep === 'Showing a block');
  assert.deepEqual(ctx.calls.status[after + 1], { state: 'think', currentStep: 'Thinking' });
  assert.equal(m.sessionId, '5a475f66-1abf-47ca-8594-e36058c69c9c');
  assert.equal(m.error, null);
  assert.ok(m.finished);
  // The model names its effort, so that’s the one reported.
  assert.deepEqual(ctx.calls.reported, [{ model: 'gemini-3.8-flash-high', effort: 'high' }]);
});

test('a recorded first turn and its resumed turn: text deltas in order, the same conversation', () => {
  const first = replay('first');
  assert.equal(first.ctx.calls.text, 'hello there\n');
  const resumed = replay('resume', { resumed: '4a34e178-df70-45b3-99b0-5e0a4cf99646' });
  assert.equal(resumed.ctx.calls.text, 'BLUE-HERON-7\n');
  assert.equal(resumed.m.missingSession, false);
  assert.equal(resumed.m.sessionId, '4a34e178-df70-45b3-99b0-5e0a4cf99646');
});

test('a recorded refused command: a denied step, worded for what happened; a glossary term stays quiet', () => {
  const { ctx, m } = replay('refused');
  assert.deepEqual(
    ctx.calls.activity.map((a) => [a.label, a.state]),
    [
      ['Ran echo hi > out.txt', 'running'],
      ['Ran echo hi > out.txt', 'denied'],
    ],
  );
  assert.match(ctx.calls.activity[1].detail, /can’t ask you from Postbox/);
  assert.doesNotMatch(ctx.calls.activity[1].detail, /user denied/);
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'Defining “heron”'));
  // agy ends the turn at the refusal without a reply, and the turn still succeeds.
  assert.equal(ctx.calls.text, '');
  assert.equal(m.error, null);
});

test('a turn agy ended at a refused call, with nothing said after it, is marked; one that went on isn’t', () => {
  assert.equal(replay('refused').m.endedOnRefusal, 'Ran echo hi > out.txt');
  // Refused only in the result’s denied_actions.
  assert.equal(replay('auto-unavailable').m.endedOnRefusal, 'Ran echo hi > out.txt');
  // Refused reads, then a model call agy retried: still the refusal that ended it.
  assert.equal(replay('error-after-refusal').m.endedOnRefusal, 'Read package.json');
  for (const name of ['block', 'first', 'resume', 'error-after-reply']) assert.equal(replay(name).m.endedOnRefusal, null, name);
  assert.match(refusalFollowUp('Ran ls -la'), /^\[Postbox\] Antigravity refused your last call \(Ran ls -la\).*Nobody was asked/);
});

test('a refusal only the result reports: auto mode unavailable, the step ended DONE, denied_actions says otherwise', () => {
  const { ctx } = replay('auto-unavailable');
  assert.deepEqual(
    ctx.calls.activity.map((a) => a.state),
    ['running', 'done', 'denied'],
  );
  assert.equal(ctx.calls.activity[2].id, ctx.calls.activity[1].id, 'the same step, corrected');
  // A step that produced output isn’t taken for the refused one.
  const ctx2 = fakeCtx();
  const m2 = createAgyMapper(ctx2);
  const step = (state, extra = {}) => ({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 2,
      state,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, ...extra },
    },
  });
  m2.push(step('ACTIVE'));
  m2.push(step('DONE', { output: 'a.txt' }));
  m2.push({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
  assert.deepEqual(
    ctx2.calls.activity.map((a) => a.state),
    ['running', 'done'],
  );
});

test('Postbox’s own tool refused (no allow rule yet): shown, with the rule to add', () => {
  const { ctx } = replay('postbox-refused');
  assert.equal(ctx.calls.activity.length, 1);
  assert.equal(ctx.calls.activity[0].state, 'denied');
  assert.equal(ctx.calls.activity[0].label, 'Showing a block');
  assert.ok(ctx.calls.activity[0].detail.includes(ALLOW_POSTBOX));
});

test('a conversation agy no longer has: it starts a new one, and the mapper says so and ignores the rest', () => {
  const { ctx, m } = replay('missing-session', { resumed: '00000000-0000-0000-0000-000000000000' });
  assert.equal(m.missingSession, true);
  assert.equal(m.sessionId, null);
  assert.equal(m.error, null, 'the stopped run’s error isn’t the turn’s');
  assert.deepEqual(ctx.calls.reported, []);
  // A new conversation, asked for none, is just a new conversation.
  assert.equal(replay('missing-session').m.missingSession, false);
});

test('agy’s ERROR after a model call it retried and went on from: the turn stands, the error is a step', () => {
  // The Gemini room UAT: the review was streamed in full after a retried call (INTERNAL, code 500).
  const { ctx, m } = replay('error-after-reply');
  assert.equal(m.finished.status, 'ERROR');
  assert.equal(m.error, null, 'no Retry that would write the review again');
  assert.equal(ctx.calls.text.trim(), m.finished.response.trim());
  const step = ctx.calls.activity.find((a) => a.id === 'agy-retried');
  assert.equal(step.state, 'done');
  assert.match(step.detail, /INTERNAL \(code 500\)/);
  // Each failed model call agy retried told the ring so.
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'The model returned an error; Antigravity is retrying'));
  // Postbox’s own calls in it stay quiet.
  assert.ok(!ctx.calls.activity.some((a) => /define|conversation/i.test(a.label)));
  // The same run: the turn went on after a retried call to a refused command, which is what ended it.
  const refused = replay('retried-then-refused');
  assert.equal(refused.m.finished.status, 'ERROR');
  assert.equal(refused.m.error, null);
  assert.deepEqual(
    refused.ctx.calls.activity.filter((a) => a.state !== 'running').map((a) => [a.label, a.state]),
    [
      ['Ran find . -maxdepth 4', 'denied'],
      ['Antigravity retried after a model error', 'done'],
    ],
    'agy’s reads of its own saved output and schemas are quiet',
  );
});

test('agy’s ERROR on a turn with no failed call, which a refused read ended: the turn stands', () => {
  // The Gemini room UAT rerun: “API error (attempt 2)”, though the stream has no error_message; the last step is
  // a read outside the agent’s folder that agy refused.
  const { ctx, m } = replay('error-after-refusal');
  assert.equal(m.finished.status, 'ERROR');
  assert.equal(m.error, null);
  const done = ctx.calls.activity.filter((a) => a.state !== 'running');
  assert.deepEqual(
    done.map((a) => [a.label, a.state]),
    [
      ['Read dedup-plan.md', 'failed'],
      ['Read package.json', 'denied'],
      ['Antigravity reported an error as the turn ended', 'failed'],
    ],
  );
  // A turn that got nowhere still fails with agy’s error.
  const ctx2 = fakeCtx();
  const m2 = createAgyMapper(ctx2);
  m2.push({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 0, state: 'DONE', step_type: 'user_input' } });
  m2.push({ event: 'result', result: { status: 'ERROR', error: 'API error (attempt 2)', response: '' } });
  assert.match(m2.error, /couldn’t run the turn: API error/);
});

test('agy’s ERROR when the retries ran out, with nothing after the last failed call: the turn fails', () => {
  const ctx = fakeCtx();
  const m = createAgyMapper(ctx);
  m.push({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Half a' } });
  m.push({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 2, state: 'DONE', step_type: 'error_message' } });
  m.push({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 3, state: 'DONE', step_type: 'error_message' } });
  m.push({ event: 'result', result: { status: 'ERROR', error: 'API error (attempt 2)', response: 'Half a' } });
  assert.match(m.error, /couldn’t run the turn: API error/);
});

test('a model agy refuses: the turn’s error says why', () => {
  const { m } = replay('bad-model');
  assert.match(m.error, /^Antigravity couldn’t run the turn: invalid model selection .*--effort is not supported/);
});

test('the models agy lists: the ids, not the names, the progress line or an error', () => {
  // (Detection itself spawns agy, which tests may not; it was checked by hand to give null and [] for a binary
  // that isn’t there and for one under /dev/null, which spawn throws for rather than reporting.)
  const out = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    '',
  ].join('\n');
  assert.deepEqual(modelIds(out), ['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']);
  assert.deepEqual(modelIds('Fetching available models...\nError: Please sign in to view available models.\n'), []);
});

test('the model: a persona that names none runs Gemini, not Claude’s default; one it names passes as it is', () => {
  assert.equal(agyModel({}), AGY_DEFAULT_MODEL);
  assert.equal(agyModel({ model: 'claude-opus-5-5' }, ['gemini-3.8-flash-high', 'gpt-oss-120b-medium']), AGY_DEFAULT_MODEL);
  assert.equal(agyModel({ model: 'claude-opus-5-5' }, ['gpt-oss-120b-medium']), 'gpt-oss-120b-medium');
  assert.equal(agyModel({ model: 'gemini-3.8-flash-low' }, ['gemini-3.8-flash-high']), 'gemini-3.8-flash-low');
  assert.equal(agyModel({ model: 'mock' }), AGY_DEFAULT_MODEL);
});

test('the effort: none where the id names it or the model refuses it; a base Gemini model takes it, up to high', () => {
  assert.equal(agyEffort('gemini-3.8-flash-high', 'max'), null);
  assert.equal(agyEffort('gemini-3.8-flash-low', 'low'), null);
  assert.equal(agyEffort('claude-sonnet-4-6', 'medium'), null);
  assert.equal(agyEffort('gpt-oss-120b-medium', 'medium'), null);
  assert.equal(agyEffort('gemini-3.8-flash', 'low'), 'low');
  assert.equal(agyEffort('gemini-3.8-flash', 'xhigh'), 'high');
  assert.equal(agyEffort('gemini-3.8-flash', undefined), 'medium');
  assert.equal(effortRun('gemini-3.8-flash-low', null), 'low');
  assert.equal(effortRun('gemini-3.8-flash', 'medium'), 'medium');
  assert.equal(effortRun('claude-sonnet-4-6', null), null);
});

test('the arguments: model, effort where it’s taken, the conversation, the mode, stream-json, the message last', () => {
  const base = { model: 'gemini-3.8-flash', effort: 'high', prompt: '-n is a flag?' };
  assert.deepEqual(agyArgs({ ...base, persona: { permissionMode: 'ask' }, sessionId: 'c1', addDirs: ['/data'] }), [
    '--model',
    'gemini-3.8-flash',
    '--effort',
    'high',
    '--conversation',
    'c1',
    '--disable-slash-commands',
    '--output-format',
    'stream-json',
    '--add-dir',
    '/data',
    '--print=-n is a flag?',
  ]);
  const mode = (permissionMode) => agyArgs({ ...base, effort: null, persona: { permissionMode } }).slice(2, -4);
  assert.deepEqual(mode('ask'), []);
  assert.deepEqual(mode('auto'), ['--mode', 'auto']);
  assert.deepEqual(mode('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(mode('bypass'), ['--dangerously-skip-permissions']);
});

test('the rules file: the guide, the note on refusals, and what the persona turned off that agy can’t', () => {
  const off = agyRules({ persona: { tools: ['web.fetch'] }, guide: 'GUIDE' });
  assert.ok(off.startsWith('GUIDE\n\n## Refused tool calls'));
  assert.match(
    off,
    /turned these off for you in Postbox: running commands \(shell\); messaging, scheduling or starting agents outside Postbox \(agents\.outside\); publishing/,
  );
  // It can ask to have one turned on (#104).
  assert.match(off, /ask_for_tool \{ tool: "shell", why \}/);
  assert.doesNotMatch(off, /fetching web pages/);
  const all = agyRules({ persona: { tools: ['shell', 'web.fetch', 'agents.outside'], canPublish: true }, guide: 'GUIDE' });
  assert.doesNotMatch(all, /What you don’t do here/);
  assert.match(off, /A refusal ends your turn there, before you can reply/);
  // Pointed at agy’s file tools, unless commands are allowed.
  assert.match(off, /Use list_dir, find_by_name, grep_search and view_file/);
  // And at read_message for what another agent showed, which its @critic went looking for on disk (#153).
  assert.match(off, /in a block is in your history and read_conversation, and read_message \{ id \} gives one item in full: it isn’t on disk/);
  assert.doesNotMatch(agyRules({ persona: { permissionMode: 'bypass' }, guide: 'G' }), /Looking at files/);
});

test('the rules name Postbox’s tools and where their schemas are, so the agent never lists the folder with a command', () => {
  const rules = agyRules({ persona: { tools: [] }, guide: 'GUIDE', schemas: '/home/you/.gemini/antigravity-cli/mcp/postbox_postbox' });
  for (const t of TOOL_DEFS) assert.ok(rules.includes(t.name), t.name);
  assert.match(rules, /read_file at \/home\/you\/\.gemini\/antigravity-cli\/mcp\/postbox_postbox\/<tool>\.json/);
  assert.match(rules, /Don’t run a command to list them/);
  assert.ok(rules.indexOf('## Postbox’s tools in Antigravity') < rules.indexOf('## Refused tool calls'));
  assert.doesNotMatch(agyRules({ persona: {}, guide: 'G' }), /Postbox’s tools in Antigravity/);
});

test('the plugin: named postbox, this conversation’s MCP URL, the rules', () => {
  const files = agyPlugin({ mcpUrl: 'http://127.0.0.1:1/mcp?session=s', rules: 'R' });
  assert.deepEqual(JSON.parse(files['plugin.json']), { name: 'postbox' });
  assert.deepEqual(JSON.parse(files['mcp_config.json']), { mcpServers: { postbox: { serverUrl: 'http://127.0.0.1:1/mcp?session=s' } } });
  assert.equal(files['rules/AGENTS.md'], 'R');
});

test('the allow rule: added once to your agy settings, keeping the rest; a file that isn’t JSON is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const file = join(dir, 'antigravity-cli', 'settings.json');
  assert.equal(await allowPostbox(file), 'added');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: [ALLOW_POSTBOX] } });
  writeFileSync(file, JSON.stringify({ trustedWorkspaces: ['/a'], permissions: { allow: ['command(git)'], deny: ['command(sudo)'] } }));
  assert.equal(await allowPostbox(file), 'added');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    trustedWorkspaces: ['/a'],
    permissions: { allow: ['command(git)', ALLOW_POSTBOX], deny: ['command(sudo)'] },
  });
  assert.equal(await allowPostbox(file), 'present');
  writeFileSync(file, '{ not json');
  assert.equal(await allowPostbox(file), 'unreadable');
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});

test('one turn at a time per folder; different folders run together', async () => {
  const q = new FolderQueue();
  const log = [];
  /** @type {(v?: any) => void} */
  let release = () => {};
  const gate = new Promise((ok) => {
    release = ok;
  });
  const a = q.run('/f', async () => {
    log.push('a start');
    await gate;
    log.push('a end');
  });
  const b = q.run('/f', async () => log.push('b'));
  const c = q.run('/g', async () => log.push('c'));
  await c;
  assert.ok(q.busy('/f'));
  assert.deepEqual(log, ['a start', 'c']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(log, ['a start', 'c', 'a end', 'b']);
  assert.equal(q.busy('/f'), false);
});

test('in a git repository, the plugin folder is excluded, once; elsewhere nothing is written', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pb-agy-git-'));
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude');
  mkdirSync(join(repo, 'src', 'agent'), { recursive: true });
  // From a folder inside the repository, twice.
  assert.equal(await excludePlugin(join(repo, 'src', 'agent')), true);
  assert.equal(await excludePlugin(repo), true);
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '.agents/plugins/postbox/').length, 1);
  assert.ok(exclude.startsWith('# git ls-files'), 'what was there stays');
  assert.equal(await excludeFile(mkdtempSync(join(tmpdir(), 'pb-agy-plain-'))), null);
});

test('a worktree’s plugin is excluded in its main repository’s exclude file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-wt-'));
  mkdirSync(join(root, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(root, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  mkdirSync(join(root, 'wt'));
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'wt')}\n`);
  assert.equal(await excludeFile(join(root, 'wt')), join(root, 'main', '.git', 'info', 'exclude'));
});

/** A fake agy: it records its arguments and the plugin it found, and plays a recorded stream, once per spawn. */
function fakeSpawn(streams, seen) {
  return (_bin, args, opts) => {
    const plugin = join(opts.cwd, PLUGIN_DIR);
    seen.push({
      args,
      cwd: opts.cwd,
      killed: [],
      mcp: existsSync(plugin) && JSON.parse(readFileSync(join(plugin, 'mcp_config.json'), 'utf8')),
      rules: existsSync(plugin) && readFileSync(join(plugin, 'rules', 'AGENTS.md'), 'utf8'),
    });
    const me = seen.at(-1);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: (sig) => me.killed.push(sig) });
    const { lines, code, stderr = '' } = streams.shift();
    setImmediate(() => {
      for (const e of lines) child.stdout.write(`${JSON.stringify(e)}\n`);
      child.stdout.end();
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
}

const adapterFor = (root, streams, seen) =>
  new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (fakeSpawn(streams, seen)),
    env: {},
  });

test('a turn: the allow rule, the plugin there while agy runs and gone after, the conversation saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const seen = [];
  const adapter = adapterFor(root, [{ lines: fixture('block'), code: 0 }], seen);
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, join(root, 'work', 'gem'));
  assert.equal(seen[0].mcp.mcpServers.postbox.serverUrl, ctx.mcpUrl);
  assert.match(seen[0].rules, /You are @gem, an agent in Postbox/);
  assert.ok(seen[0].rules.includes(join(root, 'mcp', 'postbox_postbox', 'show_block.json')), 'the schemas beside the settings file');
  assert.equal(seen[0].args.at(-1), '--print=Tea or coffee?');
  assert.ok(!seen[0].args.includes('--effort'), 'the model names its effort');
  assert.deepEqual(readdirSync(join(root, 'work', 'gem')), [], 'the plugin, and the .agents folder it made, are gone');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).permissions.allow, [ALLOW_POSTBOX]);
  assert.equal(ctx.calls.saved.agySessionId, '5a475f66-1abf-47ca-8594-e36058c69c9c');
  assert.equal(ctx.calls.saved.model, 'gemini-3.8-flash-high');
});

test('a folder’s own .agents folder stays; only Postbox’s plugin is removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const folder = join(root, 'project');
  mkdirSync(join(folder, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(folder, '.agents', 'rules', 'style.md'), 'Be brief.');
  const adapter = adapterFor(root, [{ lines: fixture('first'), code: 0 }], []);
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, fakeCtx({ project: { folder } }));
  assert.deepEqual(readdirSync(join(folder, '.agents')), ['rules']);
});

/** A recorded stream, as if it were in another conversation. */
const inConversation = (id, lines) => JSON.parse(JSON.stringify(lines).replace(/"conversation_id":"[^"]*"/g, `"conversation_id":"${id}"`));

test('a turn agy ended at a refusal goes on once, in the same conversation, for the agent to say what was refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const seen = [];
  const adapter = adapterFor(
    root,
    [
      { lines: fixture('refused'), code: 0 },
      // The follow-up resumes the same conversation.
      { lines: inConversation('ecb9ae82-d2c0-49dc-ac0d-638934ef0cb8', fixture('first')), code: 0 },
    ],
    seen,
  );
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Run it.' }, ctx);
  assert.equal(seen.length, 2);
  assert.ok(!seen[0].args.includes('--conversation'));
  assert.equal(seen[1].args[seen[1].args.indexOf('--conversation') + 1], 'ecb9ae82-d2c0-49dc-ac0d-638934ef0cb8');
  assert.equal(seen[1].args.at(-1), `--print=${refusalFollowUp('Ran echo hi > out.txt')}`);
  assert.ok(seen[1].mcp, 'the plugin is still there for it');
  assert.equal(ctx.calls.text, 'hello there\n');
  assert.ok(ctx.calls.status.some((x) => x.currentStep === 'Telling you about the refused call'));
  // A refusal in the follow-up isn’t followed up again, and a turn that ended well isn’t followed up at all.
  const again = [];
  await adapterFor(
    mkdtempSync(join(tmpdir(), 'pb-agy-')),
    [
      { lines: fixture('refused'), code: 0 },
      { lines: fixture('refused'), code: 0 },
    ],
    again,
  ).deliver({}, { kind: 'user', text: 'Run it.' }, fakeCtx());
  assert.equal(again.length, 2);
  const once = [];
  await adapterFor(mkdtempSync(join(tmpdir(), 'pb-agy-')), [{ lines: fixture('block'), code: 0 }], once).deliver({}, { kind: 'user', text: 'hi' }, fakeCtx());
  assert.equal(once.length, 1);
});

test('a conversation agy no longer has: that run is stopped, and the turn starts over once, saying so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const seen = [];
  const adapter = adapterFor(
    root,
    [
      { lines: fixture('missing-session'), code: 1 },
      { lines: fixture('first'), code: 0 },
    ],
    seen,
  );
  const ctx = fakeCtx({ state: { agySessionId: '00000000-0000-0000-0000-000000000000' } });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].args.includes('--conversation'));
  assert.deepEqual(seen[0].killed, ['SIGINT']);
  assert.ok(!seen[1].args.includes('--conversation'));
  assert.match(seen[1].args.at(-1), /^--print=\[Postbox\] .*fresh start/);
  assert.equal(ctx.calls.saved.agySessionId, '0ae7122a-45f5-4b91-b881-2fce3ac66a12');
  assert.equal(ctx.calls.text, 'hello there\n');
});

test('a failed turn rejects with what agy said, and still removes the plugin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const adapter = adapterFor(root, [{ lines: fixture('bad-model'), code: 1 }], []);
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'hi' }, fakeCtx()), /--effort is not supported for model/);
  assert.deepEqual(readdirSync(join(root, 'work', 'gem')), []);
  assert.match(exitError(2, 'warning: something\nerror: boom\n'), /^Antigravity exited with code 2: error: boom\.$/);
});

test('Stop: agy gets SIGINT, and the turn ends without an error; a turn stopped while it waits never starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const seen = [];
  const ctx = fakeCtx();
  const play = fakeSpawn([{ lines: fixture('first').slice(0, 2), code: 130 }], seen);
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    // Stop is pressed as soon as agy starts.
    spawnImpl: /** @type {any} */ (
      (...a) => {
        const child = play(...a);
        ctx.abort.abort();
        return child;
      }
    ),
    env: {},
  });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.deepEqual(seen[0].killed, ['SIGINT']);
  const early = fakeCtx();
  early.abort.abort();
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, early);
  assert.equal(seen.length, 1);
});

test('Stop signals agy’s whole process group, and the turn ends once the group is gone (#126)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-'));
  const seen = [];
  const ctx = fakeCtx();
  const play = fakeSpawn([{ lines: fixture('first').slice(0, 2), code: 130 }], seen);
  /** @type {any[]} */
  const signals = [];
  let closed = false;
  let detached = null;
  const adapter = new AntigravityCliAdapter({
    workRoot: join(root, 'work'),
    settingsFile: join(root, 'settings.json'),
    spawnImpl: /** @type {any} */ (
      (bin, args, opts) => {
        detached = opts.detached;
        const child = /** @type {any} */ (play(bin, args, opts));
        child.pid = 4242;
        child.on('close', () => {
          closed = true;
        });
        ctx.abort.abort();
        return child;
      }
    ),
    env: {},
    // The group is there until the process has closed: signal 0 then fails, as process.kill does.
    kill: /** @type {any} */ (
      (pid, sig) => {
        if (sig === 0 && closed) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        if (sig !== 0) signals.push([pid, sig]);
        return true;
      }
    ),
    listProcesses: async () => [],
  });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.equal(detached, true, 'agy starts in a process group of its own');
  assert.deepEqual(signals[0], [-4242, 'SIGINT'], 'Stop signals the group, not only agy');
  assert.equal(closed, true);
});
