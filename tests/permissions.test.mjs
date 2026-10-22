// #66 with #10: permission cards (Always allow, Edit, Don’t allow with a reason, a subagent’s prompt) and the
// permissions panel (its rules with their sources, rules for this conversation, folders, the mode).

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { alwaysAllow, changeRule, cleanRule, readRules, settingsFiles } from '../server/permission-rules.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Claude Code agent whose turns the test scripts, working in a temp folder. */
class ScriptedClaude {
  name = 'claude-code';
  constructor(folder) {
    this.folder = folder;
    this.next = [];
    this.calls = [];
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, message, ctx) {
    this.calls.push({ message, ctx });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx);
  }
}

async function setup({ usesHostSetup = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pb-perm-'));
  const folder = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(folder);
  await mkdir(home);
  const store = new Store(null);
  const adapter = new ScriptedClaude(folder);
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', usesHostSetup, tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  return { root, folder, home, store, rt, adapter, p, t, se };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
  await sleep(5);
};
const openCard = (store, t) => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');

// ── Cards ─────────────────────────────────────────────────────────────────────────────

test('#66: Always allow returns the prompt’s own suggestions, shown in words first; a session-only rule is saved locally', async () => {
  const { rt, store, t, adapter } = await setup();
  let answer;
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }];
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'npm test', input: { command: 'npm test' }, suggestions });
  });
  rt.sendMessage(t.id, { text: 'test it' });
  await sleep(20);
  const card = openCard(store, t);
  assert.deepEqual(
    card.always.lines.map((l) => l.text),
    ['Always allow Bash(npm test:*) in this folder (.claude/settings.local.json)'],
  );
  assert.match(card.always.moved, /session only.*local settings/);
  await rt.act(t.id, card.id, 'always', {});
  await settle(rt);
  assert.equal(answer.allow, true);
  assert.deepEqual(answer.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
  ]);
  assert.equal(store.item(t.id, card.id).status, 'allowed-always');
  assert.match(store.items(t.id).find((i) => i.kind === 'voice').text, /^Always allowed \(Bash\(npm test:\*\)\): @coder to run a command/);
});

test('#66: without suggestions (the CLI sends none), Always allow saves Postbox’s rule in the folder’s local settings', async () => {
  const { rt, store, t, adapter, folder } = await setup();
  let answer;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'echo hi > note.txt', input: { command: 'echo hi > note.txt' } });
  });
  rt.sendMessage(t.id, { text: 'write it' });
  await sleep(20);
  const card = openCard(store, t);
  // A command that redirects only ever gets its exact text allowed (permission-rules.mjs, rulesFor).
  assert.equal(card.always.lines[0].text, 'Always allow Bash(echo hi > note.txt) in this folder (.claude/settings.local.json)');
  await rt.act(t.id, card.id, 'always', {});
  await settle(rt);
  assert.deepEqual(answer, { allow: true });
  const saved = JSON.parse(await readFile(join(folder, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(saved.permissions.allow, ['Bash(echo hi > note.txt)']);
});

test('#66: a mock agent’s card offers no Always allow: it reads no rules', async () => {
  const store = new Store(null);
  let answer;
  const mock = {
    name: 'mock',
    async deliver(_s, _m, ctx) {
      answer = await ctx.askPermission({ tool: 'Bash', summary: 'run a command', detail: 'rm -rf x' });
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(mock),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: '/nowhere' },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'mocky' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(20);
  const card = openCard(store, t);
  assert.equal(card.always, null);
  assert.throws(() => rt.act(t.id, card.id, 'always', {}), /only be allowed once/);
  rt.act(t.id, card.id, 'allow');
  await settle(rt);
  assert.equal(answer.allow, true);
});

test('#10: Edit allows the changed command, or changed JSON, and refuses JSON that doesn’t parse', async () => {
  const { rt, store, t, adapter } = await setup();
  const answers = [];
  adapter.next.push(async (c) => {
    answers.push(await c.askPermission({ tool: 'Bash', summary: 'run a command', input: { command: 'npm test', description: 'Test' } }));
    answers.push(await c.askPermission({ tool: 'WebFetch', summary: 'fetch a page', input: { url: 'https://a.example/x', prompt: 'p' } }));
  });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(20);
  let card = openCard(store, t);
  assert.throws(() => rt.act(t.id, card.id, 'edit', { command: '  ' }), /Write the command/);
  rt.act(t.id, card.id, 'edit', { command: 'npm test -- --ci' });
  await sleep(20);
  card = openCard(store, t);
  assert.throws(() => rt.act(t.id, card.id, 'edit', { input: '{ "url": ' }), /isn’t valid JSON/);
  assert.throws(() => rt.act(t.id, card.id, 'edit', { input: '[1]' }), /JSON object/);
  rt.act(t.id, card.id, 'edit', { input: '{ "url": "https://b.example/y", "prompt": "p" }' });
  await settle(rt);
  assert.deepEqual(answers[0], { allow: true, updatedInput: { command: 'npm test -- --ci', description: 'Test' } });
  assert.deepEqual(answers[1], { allow: true, updatedInput: { url: 'https://b.example/y', prompt: 'p' } });
  assert.equal(store.items(t.id).find((i) => i.kind === 'permission').edited, 'npm test -- --ci');
});

test('#10: Don’t allow with a reason sends the reason to the agent', async () => {
  const { rt, store, t, adapter } = await setup();
  let answer;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({ tool: 'Bash', summary: 'run a command', input: { command: 'rm -rf build' } });
  });
  rt.sendMessage(t.id, { text: 'clean' });
  await sleep(20);
  const card = openCard(store, t);
  rt.act(t.id, card.id, 'deny', { reason: 'Use npm run clean instead.' });
  await settle(rt);
  assert.deepEqual(answer, { allow: false, message: 'The person didn’t allow this. Their reason: Use npm run clean instead.' });
  assert.equal(store.item(t.id, card.id).reason, 'Use npm run clean instead.');
  assert.match(store.items(t.id).find((i) => i.kind === 'voice').text, /Didn’t allow: @coder to run a command \(“Use npm run clean instead\.”\)/);
});

test('#66: a subagent’s prompt names the subagent, from the stream', async () => {
  const { rt, store, t, adapter } = await setup();
  adapter.next.push(async (c) => {
    c.subagentNames(({ toolUseId }) => (toolUseId === 'toolu_sub' ? 'general-purpose' : null));
    await c.askPermission({ tool: 'Bash', summary: 'run a command', toolUseId: 'toolu_sub', input: { command: 'ls' } });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(20);
  const card = openCard(store, t);
  assert.equal(card.who, 'general-purpose');
  rt.act(t.id, card.id, 'allow');
  await settle(rt);
  assert.match(store.items(t.id).find((i) => i.kind === 'voice').text, /^Allowed: @coder’s subagent \(general-purpose\) to run a command/);
});

test('#66: MCP permission_prompt passes suggestions and the agent id, and answers with your edit or Always allow', async () => {
  const { rt, store, t, adapter, se } = await setup();
  const replies = [];
  const ask = (args) => handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } });
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//data/**' }], behavior: 'allow', destination: 'localSettings' }];
  adapter.next.push(async (c) => {
    c.subagentNames(({ agentId }) => (agentId === 'task-1' ? 'Explore' : null));
    const one = ask({ tool_name: 'Read', input: { file_path: '/data/a' }, tool_use_id: 'tu1', permission_suggestions: suggestions, agent_id: 'task-1' });
    await sleep(10);
    const card = openCard(store, t);
    assert.equal(card.who, 'Explore');
    rt.act(t.id, card.id, 'always', {});
    replies.push(await one);
    const two = ask({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu2' });
    await sleep(10);
    rt.act(t.id, openCard(store, t).id, 'edit', { command: 'ls -la' });
    replies.push(await two);
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const [a, b] = replies.map((r) => JSON.parse(r.result.content[0].text));
  assert.deepEqual(a, { behavior: 'allow', updatedInput: { file_path: '/data/a' }, updatedPermissions: suggestions });
  assert.deepEqual(b, { behavior: 'allow', updatedInput: { command: 'ls -la' } });
});

test('#66: suggestions are bounded; the project’s shared settings go local; modes and folders stay for the turn', () => {
  assert.equal(alwaysAllow(null), null);
  assert.equal(alwaysAllow([{ type: 'removeRules', rules: [], behavior: 'allow', destination: 'localSettings' }]), null);
  const a = alwaysAllow([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make:*' }], behavior: 'allow', destination: 'projectSettings' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'userSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/data'], destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 42 }], behavior: 'allow', destination: 'localSettings' },
    'nonsense',
  ]);
  assert.deepEqual(
    a.updates.map((u) => u.destination),
    ['localSettings', 'userSettings', 'session', 'session'],
  );
  assert.match(a.moved, /shared settings/);
  assert.deepEqual(
    a.lines.map((l) => l.text),
    [
      'Always allow Bash(make:*) in this folder (.claude/settings.local.json)',
      'Always allow WebFetch everywhere you use Claude Code (~/.claude/settings.json)',
      'Switch to accept edits mode for the rest of this turn',
      'Let it work in /data for the rest of this turn',
    ],
  );
});

// ── The panel ─────────────────────────────────────────────────────────────────────────

test('#66: the panel reads each source’s rules, the persona’s Tools as deny rules, and says when a file can’t be read', async () => {
  const { rt, folder, home, p, se } = await setup();
  await mkdir(join(home, '.claude'));
  await mkdir(join(folder, '.claude'));
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'], additionalDirectories: ['/srv'] } }));
  await writeFile(join(folder, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./.env)'] } }));
  await writeFile(join(folder, '.claude', 'settings.local.json'), '{ not json');
  const v = await rt.permissionsView({ sessionId: se.id });
  assert.equal(v.persona.handle, 'coder');
  assert.equal(v.persona.permissionMode, 'ask');
  assert.deepEqual(
    v.files.map((f) => [f.source, f.writable, f.allow, f.deny, Boolean(f.error)]),
    [
      ['user', true, ['Bash(git status)'], [], false],
      ['project', false, [], ['Read(./.env)'], false],
      ['local', true, [], [], true],
    ],
  );
  // shell is ticked; web.fetch and agents.outside aren’t, so their tools are deny rules from the persona’s Tools.
  assert.deepEqual(
    v.tools.map((x) => [x.id, x.on]),
    [
      ['shell', true],
      ['web.fetch', false],
      ['agents.outside', false],
    ],
  );
  assert.ok(v.publishing.includes('Artifact'));
  assert.deepEqual(
    v.folders.map((f) => f.source),
    ['folder', 'user'],
  );
  // An Isolated persona doesn’t read the user’s settings, so they aren’t shown.
  rt.updatePersona(p.id, { usesHostSetup: false });
  assert.deepEqual(
    (await rt.permissionsView({ sessionId: se.id })).files.map((f) => f.source),
    ['project', 'local'],
  );
});

test('#66: rules are saved locally by default, for this conversation or the user on request, never in the project’s file', async () => {
  const { rt, store, folder, home, se, t, adapter, p } = await setup();
  await rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: ' Bash(npm test:*) ' });
  assert.deepEqual(JSON.parse(await readFile(join(folder, '.claude', 'settings.local.json'), 'utf8')).permissions.allow, ['Bash(npm test:*)']);
  await rt.changePermissionRule({ sessionId: se.id, behavior: 'deny', rule: 'WebFetch', where: 'user' });
  assert.deepEqual(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).permissions.deny, ['WebFetch']);
  await rt.changePermissionRule({ sessionId: se.id, behavior: 'ask', rule: 'Bash(git push:*)', where: 'conversation' });
  assert.deepEqual(store.state.sessions[se.id].rules, { allow: [], ask: ['Bash(git push:*)'], deny: [] });
  await assert.rejects(rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: 'Bash', where: 'project' }), /shared with your team/);
  await assert.rejects(rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: 'not a rule!' }), /isn’t a rule/);
  await assert.rejects(rt.changePermissionRule({ sessionId: se.id, behavior: 'maybe', rule: 'Bash' }), /allows, asks or denies/);
  // Removing works the same way.
  await rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: 'Bash(npm test:*)', remove: true });
  assert.deepEqual(JSON.parse(await readFile(join(folder, '.claude', 'settings.local.json'), 'utf8')).permissions.allow, []);
  // The conversation’s rules reach the agent’s next turn.
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.deepEqual(adapter.calls.at(-1).ctx.rules, { allow: [], ask: ['Bash(git push:*)'], deny: [] });
  // An Isolated persona doesn’t read user settings, so a rule there would do nothing.
  rt.updatePersona(p.id, { usesHostSetup: false });
  await assert.rejects(rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: 'Bash', where: 'user' }), /isolated/);
});

test('#66: a folder added for the conversation reaches the next turn; a path that isn’t a folder is refused', async () => {
  const { rt, root, se, t, adapter } = await setup();
  const data = join(root, 'data');
  await mkdir(data);
  await rt.changePermissionFolder({ sessionId: se.id, path: data });
  await assert.rejects(rt.changePermissionFolder({ sessionId: se.id, path: join(root, 'nope') }), /isn’t a folder/);
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  assert.deepEqual(adapter.calls.at(-1).ctx.addDirs, [data]);
  await rt.changePermissionFolder({ sessionId: se.id, path: data, remove: true });
  assert.deepEqual(rt.s.sessions[se.id].addDirs, []);
});

test('#66: the mode changes the persona, and a running turn too where the backend allows it', async () => {
  const { rt, t, adapter, p } = await setup();
  const set = [];
  let release;
  adapter.next.push(async (c) => {
    c.control({ setPermissionMode: async (m) => set.push(m) > 0 });
    await new Promise((r) => {
      release = r;
    });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(20);
  const r = await rt.setPermissionMode(p.id, 'acceptEdits');
  assert.deepEqual(r, { ok: true, now: ['coder'] });
  assert.deepEqual(set, ['acceptEdits']);
  assert.equal(rt.persona(p.id).permissionMode, 'acceptEdits');
  release();
  await settle(rt);
  // No running turn: it applies from the next one, which the persona’s mode decides.
  assert.deepEqual(await rt.setPermissionMode(p.id, 'ask'), { ok: true, now: [] });
  await assert.rejects(rt.setPermissionMode(p.id, 'yolo'), /Permissions are one of/);
});

test('#66: rules files are changed atomically, and one that isn’t JSON is never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-rules-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, JSON.stringify({ env: { A: '1' }, permissions: { ask: ['Bash'] } }));
  assert.deepEqual(await changeRule(file, { behavior: 'ask', rule: 'Bash' }), { file, changed: false });
  await changeRule(file, { behavior: 'ask', rule: 'Bash', remove: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { env: { A: '1' }, permissions: { ask: [] } });
  await writeFile(file, '[1, 2]');
  await assert.rejects(changeRule(file, { behavior: 'ask', rule: 'Bash' }), /doesn’t hold settings/);
  assert.equal(await readFile(file, 'utf8'), '[1, 2]');
  assert.equal(cleanRule('mcp__github__create_issue'), 'mcp__github__create_issue');
  assert.equal(cleanRule('Bash(rm -rf /'), null);
  assert.equal(cleanRule('x'.repeat(600)), null);
  const missing = await readRules({ folder: join(dir, 'none'), home: dir, usesHostSetup: false });
  assert.deepEqual(
    missing.map((s) => [s.source, s.exists]),
    [
      ['project', false],
      ['local', false],
    ],
  );
});

// ── Review fixes ──────────────────────────────────────────────────────────────────────

/** Opens one card for a request, and returns it. */
async function cardFor(req) {
  const env = await setup();
  env.adapter.next.push(async (c) => {
    await c.askPermission(req);
  });
  env.rt.sendMessage(env.t.id, { text: 'go' });
  await sleep(20);
  return { ...env, card: openCard(env.store, env.t) };
}

test('#66: no Always allow when the SDK says a saved rule would grant more, or sends no suggestions; the CLI gets Postbox’s rule', async () => {
  const rm = { tool: 'Bash', summary: 'run a command', input: { command: 'rm -rf build' } };
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'localSettings' }];
  assert.equal((await cardFor({ ...rm, suggestions, suppressAlways: true })).card.always, null);
  // The SDK sends a list, and an empty one means nothing to allow always: no broader rule is made up.
  assert.equal((await cardFor({ ...rm, suggestions: [] })).card.always, null);
  // The CLI’s prompt tool sends no list at all (recorded): Postbox’s rule.
  assert.equal((await cardFor(rm)).card.always.saves, 'Bash(rm:*)');
});

test('#66: a rule too long to keep (a heredoc) or a tool name past the bound offers no Always allow', async () => {
  const heredoc = `cat > big.txt <<'EOF'\n${'line\n'.repeat(20000)}EOF`;
  const { card } = await cardFor({ tool: 'Bash', summary: 'run a command', input: { command: heredoc } });
  assert.equal(card.always, null);
  const long = await cardFor({ tool: `mcp__${'x'.repeat(300)}`, summary: 'use a tool', input: {} });
  assert.equal(long.card.always, null);
  assert.equal(long.card.tool.length, 120);
  // Suggested rules past the bound are left out whole, never cut short.
  assert.equal(
    alwaysAllow([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(600) }], behavior: 'allow', destination: 'localSettings' }]),
    null,
  );
});

test('#10: Edit isn’t offered for an input too large to keep, and is refused if asked for', async () => {
  const big = await cardFor({ tool: 'Bash', summary: 'run a command', detail: 'x'.repeat(4000), input: { command: 'x'.repeat(20000), description: 'Big' } });
  assert.equal(big.card.input, null);
  assert.throws(() => big.rt.act(big.t.id, big.card.id, 'edit', { command: 'echo short' }), /too large to edit/);
});

test('#10: the edited command keeps the call’s other fields in the answer', async () => {
  const { rt, store, t, adapter } = await setup();
  let answer;
  adapter.next.push(async (c) => {
    answer = await c.askPermission({
      tool: 'Bash',
      summary: 'run a command',
      input: { command: 'npm test', description: 'Test', timeout: 60000, run_in_background: true },
    });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await sleep(20);
  rt.act(t.id, openCard(store, t).id, 'edit', { command: 'npm test -- --ci' });
  await settle(rt);
  assert.deepEqual(answer.updatedInput, { command: 'npm test -- --ci', description: 'Test', timeout: 60000, run_in_background: true });
});

test('#66: a mode suggested for a settings file isn’t offered; one for the session lasts the turn', () => {
  assert.equal(alwaysAllow([{ type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' }]), null);
  assert.equal(alwaysAllow([{ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }]), null);
  assert.deepEqual(alwaysAllow([{ type: 'setMode', mode: 'acceptEdits', destination: 'cliArg' }]).updates, [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
});

test('#66: two rules saved at once both land, and nothing is left behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-rules-'));
  const file = join(dir, 'settings.local.json');
  await writeFile(file, '{}');
  const rules = Array.from({ length: 8 }, (_, i) => `Bash(make t${i}:*)`);
  const results = await Promise.all(rules.map((rule) => changeRule(file, { behavior: 'allow', rule })));
  assert.ok(results.every((r) => r.changed));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permissions.allow, rules);
  assert.deepEqual(await readdir(dir), ['settings.local.json'], 'no temporary files left');
  // One that fails doesn’t stop the next.
  await writeFile(file, '{ broken');
  const [bad, good] = await Promise.allSettled([
    changeRule(file, { behavior: 'allow', rule: 'Bash' }),
    changeRule(join(dir, 'other.json'), { behavior: 'allow', rule: 'Bash' }),
  ]);
  assert.equal(bad.status, 'rejected');
  assert.equal(good.status, 'fulfilled');
});

test('#66: a settings file that’s a link stays a link, and its target gets the rule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-rules-'));
  await mkdir(join(dir, 'dotfiles'));
  await mkdir(join(dir, 'home', '.claude'), { recursive: true });
  const target = join(dir, 'dotfiles', 'claude-settings.json');
  await writeFile(target, JSON.stringify({ theme: 'dark' }));
  const link = join(dir, 'home', '.claude', 'settings.json');
  await symlink(target, link);
  await changeRule(link, { behavior: 'deny', rule: 'WebFetch' });
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { theme: 'dark', permissions: { deny: ['WebFetch'] } });
  assert.deepEqual((await readdir(join(dir, 'dotfiles'))).sort(), ['claude-settings.json']);
});

test('#66: CLAUDE_CONFIG_DIR moves the user settings, as Claude Code reads them', async () => {
  assert.equal(settingsFiles('/w', '/home/me').user, '/home/me/.claude/settings.json');
  assert.equal(settingsFiles('/w', '/home/me', '/cfg').user, '/cfg/settings.json');
  const { rt, root, se } = await setup();
  rt.configDir = join(root, 'cfg');
  await rt.changePermissionRule({ sessionId: se.id, behavior: 'allow', rule: 'Bash(ls)', where: 'user' });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'cfg', 'settings.json'), 'utf8')).permissions.allow, ['Bash(ls)']);
  assert.equal((await rt.permissionsView({ sessionId: se.id })).files.find((x) => x.source === 'user').file, join(root, 'cfg', 'settings.json'));
});
