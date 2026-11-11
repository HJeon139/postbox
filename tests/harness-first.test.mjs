// Harness first: in Auto, the harness decides. Postbox adds no ask rules of its own for writes outside (WRITE_TOOLS,
// server/adapters/setup.mjs), so a call Claude Code’s Auto allows runs with no Postbox card, and a card shows only when
// the harness itself asks. Ask me and Accept edits keep Postbox’s write asks (#112), and Run everything has none.
// The host side is tests/harness-first-host.test.mjs.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code.mjs';
import { WRITE_TOOLS, writeRules } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { decide } from '../shared/permission-match.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cliBase = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
const after = (args, flag) => args[args.indexOf(flag) + 1];
/** The ask rules a turn hands Claude Code: the CLI’s --settings, and the SDK’s settings. */
const cliAsk = (persona, rules) => JSON.parse(after(claudeArgs({ ...cliBase, persona, rules }), '--settings')).permissions?.ask ?? [];
const sdkAsk = (persona, rules) => sdkOptions({ ...sdkBase, persona, rules }).settings.permissions?.ask ?? [];
const writeEntries = (ask) => ask.filter((r) => WRITE_TOOLS.includes(r));

// The calls behind the decision: a push chained with a read of the remote, and a PR from a body file.
const PUSH = 'git push origin feat/x && git ls-remote origin feat/x';
const PR = 'gh pr create --repo HJeon139/postbox --head feat/x --title t --body-file /tmp/b.md';

/** What Claude Code decides for a command with only these ask rules, as the permissions panel reads it. */
const verdict = (ask, command, mode) =>
  decide({
    call: `Bash(${command})`,
    rules: { deny: [], ask: ask.map((rule) => ({ rule, source: 'writes', unless: [] })), allow: [] },
    mode,
    cwd: '/w',
    home: '/h',
  });

test('in Auto, Postbox adds no write ask rules of its own; Ask me and Accept edits keep them, and Run everything has none', () => {
  assert.deepEqual(writeRules({ permissionMode: 'auto' }), []);
  assert.deepEqual(writeRules({ permissionMode: 'ask' }), WRITE_TOOLS);
  assert.deepEqual(writeRules({ permissionMode: 'acceptEdits' }), WRITE_TOOLS);
  assert.deepEqual(writeRules({ permissionMode: 'bypass' }), []);
});

test('a persona with no mode set runs in Auto, so it gets no write ask rules either', () => {
  // claudeArgs and sdkOptions read a missing mode as auto (MODES’ default), as the runtime does.
  assert.deepEqual(writeRules({}), []);
  assert.deepEqual(writeRules({ model: 'mock' }), []);
});

test('a Claude Code CLI turn in Auto gets no write ask rule in --settings; in Ask me it gets every one', () => {
  assert.deepEqual(writeEntries(cliAsk({ model: 'mock', permissionMode: 'auto' })), []);
  assert.deepEqual(cliAsk({ model: 'mock', permissionMode: 'ask' }), WRITE_TOOLS);
});

test('an Agent SDK turn in Auto gets no write ask rule in its settings; in Ask me it gets every one', () => {
  assert.deepEqual(writeEntries(sdkAsk({ model: 'mock', permissionMode: 'auto' })), []);
  assert.deepEqual(sdkAsk({ model: 'mock', permissionMode: 'ask' }), WRITE_TOOLS);
});

test('the person’s own conversation ask rules stay in Auto and in Ask me, for both backends', () => {
  const rules = { ask: ['Bash(npm publish:*)'] };
  for (const ask of [cliAsk, sdkAsk]) {
    assert.deepEqual(ask({ model: 'mock', permissionMode: 'auto' }, rules), ['Bash(npm publish:*)'], ask.name);
    assert.deepEqual(ask({ model: 'mock', permissionMode: 'ask' }, rules), [...WRITE_TOOLS, 'Bash(npm publish:*)'], ask.name);
  }
});

test('in Auto, a chained git push and a gh pr create meet no ask rule of Postbox’s, so the harness decides them', () => {
  for (const ask of [cliAsk({ model: 'mock', permissionMode: 'auto' }), sdkAsk({ model: 'mock', permissionMode: 'auto' })])
    for (const command of [PUSH, PR]) {
      const v = verdict(ask, command, 'auto');
      assert.equal(v.decision, 'mode', `${command}: ${JSON.stringify(v)}`);
    }
});

test('in Ask me, a chained git push and a gh pr create still meet Postbox’s write ask rule', () => {
  for (const ask of [cliAsk({ model: 'mock', permissionMode: 'ask' }), sdkAsk({ model: 'mock', permissionMode: 'ask' })]) {
    const push = verdict(ask, PUSH, 'ask');
    assert.deepEqual([push.decision, push.rule, push.part], ['ask', 'Bash(git push:*)', 'git push origin feat/x']);
    assert.deepEqual([verdict(ask, PR, 'ask').decision, verdict(ask, PR, 'ask').rule], ['ask', 'Bash(gh pr create:*)']);
  }
});

/** A Claude Code agent whose turns the test scripts, working in a temp folder (as tests/write-guard.test.mjs’s). */
async function setup(persona = {}) {
  const root = tempDir('pb-harness-first-');
  const folder = join(root, 'work');
  await mkdir(join(folder, '.claude'), { recursive: true });
  const store = new Store(null);
  const next = [];
  const adapter = {
    name: 'claude-code',
    folderFor: async () => folder,
    async deliver(_s, _m, ctx) {
      const step = next.shift() ?? (async (c) => c.text('ok'));
      await step(ctx);
    },
  };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus,
    config: { origin: 'http://x', imageOrigins: [], lintSettleMs: 0, home: root },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'], ...persona });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { rt, store, t, p, next };
}

test('the permissions panel shows no write ask rules for an Auto persona, nor for one stored as Ask me, which runs Auto', async () => {
  const auto = await setup();
  assert.deepEqual((await auto.rt.permissionsView({ personaId: auto.p.id })).writes.rules, []);
  const ask = await setup({ permissionMode: 'ask' });
  assert.deepEqual((await ask.rt.permissionsView({ personaId: ask.p.id })).writes.rules, []);
});

test('in Auto, a prompt the harness itself sends for a push still makes a card, marked as a write outside', async () => {
  // Passes on main by design: the harness’s own ask must keep its card after the change too.
  const { rt, store, t, next } = await setup();
  const answers = [];
  next.push(async (c) => answers.push(await c.askPermission({ tool: 'Bash', summary: 'run a command', input: { command: PUSH } })));
  rt.sendMessage(t.id, { text: 'Carry on.' });
  const card = () => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
  for (let i = 0; i < 200 && !card(); i++) await sleep(10);
  assert.ok(card(), 'a card for the harness’s ask');
  assert.deepEqual([card().outside, card().where], [true, { server: 'git', target: { what: 'remote', name: 'origin' } }]);
  assert.equal(answers.length, 0, 'the call waits on the card');
  await rt.act(t.id, card().id, 'allow', {});
  for (let i = 0; i < 50 && !answers.length; i++) await sleep(5);
  assert.equal(answers[0]?.allow, true);
});
