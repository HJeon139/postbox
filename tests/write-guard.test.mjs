// #112: a call that writes outside Postbox comes to a permission card that shows its draft, before anything exists
// outside, unless the person already settled it (Always allow for that tool, or “Can publish” for publishing tools).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { codexApproval } from '../server/adapters/codex.mjs';
import { WRITE_TOOLS, writeRules } from '../server/adapters/setup.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { draftOf, isWriteCall, whereOf } from '../server/write-guard.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { decide } from '../shared/permission-match.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the write rules catch tools and gh commands that create, change or delete outside, and never a read or Postbox’s own', () => {
  for (const tool of [
    'mcp__claude_ai_Claude_Docs__create',
    'mcp__docs__create_document',
    'mcp__notion__notion_create_page',
    'mcp__github__update_issue',
    'mcp__github__add_issue_comment',
    'mcp__linear__issue_update',
    'mcp__claude_ai_Google_Drive__copy_file',
    'mcp__filesystem__write_file',
    'mcp__memory__delete_entities',
    // Hyphenated and camelCase names, from real connectors: none is on the publishing deny list.
    'mcp__claude_ai_Notion__notion-create-pages',
    'mcp__claude_ai_Notion__notion-update-page',
    'mcp__linear__createIssue',
    'mcp__atlassian__createConfluencePage',
    'mcp__jira__jiraCreateIssue',
    'mcp__x__updateIssue',
    'mcp__x__update-page',
  ])
    assert.ok(isWriteCall(tool, {}), tool);
  for (const tool of [
    'mcp__docs__read_document',
    'mcp__github__get_issue',
    'mcp__github__search_issues',
    'mcp__claude_ai_Google_Drive__list_recent_files',
    'mcp__x__get_asset_list',
    'mcp__claude_ai_Notion__notion-search',
    'mcp__claude_ai_Notion__notion-fetch',
    'mcp__filesystem__search_files',
    'mcp__filesystem__read_file',
    'mcp__x__getAddress',
    'mcp__x__settings',
    'Read',
    'WebFetch',
  ])
    assert.ok(!isWriteCall(tool, {}), tool);
  // Ask beats allow, and Claude Code’s globs can’t leave a server out, so a rule that matches one of Postbox’s own
  // tools makes each call a permission_prompt round trip (Postbox allows it, with no card). A new clash fails here: add
  // the tool to ROUND_TRIP only if that cost is accepted (#173’s add_dataset matches mcp__*__add_*).
  // add_dataset (#47): one permission_prompt round trip per call, which Postbox allows at once, with no card.
  const ROUND_TRIP = ['add_dataset'];
  assert.deepEqual(
    TOOL_DEFS.map((t) => t.name).filter((n) => isWriteCall(`mcp__postbox__${n}`, {})),
    ROUND_TRIP,
  );
  assert.ok(isWriteCall('Bash', { command: 'gh issue create --title "Fix it" --body "…"' }));
  assert.ok(isWriteCall('Bash', { command: 'cd repo && gh pr comment 12 --body hi' }));
  assert.ok(!isWriteCall('Bash', { command: 'gh issue list --state open' }));
  assert.ok(!isWriteCall('Bash', { command: 'npm test' }));
  // Bypass runs everything: no asks for it.
  assert.deepEqual(writeRules({ permissionMode: 'bypass' }), []);
  assert.deepEqual(writeRules({ permissionMode: 'auto' }), WRITE_TOOLS);
});

test('a write’s draft is its longest text field, for MCP writes only', () => {
  assert.deepEqual(draftOf('mcp__docs__create_document', { title: 'Use case 05', content: '# Use case 05\n\nBody' }), {
    field: 'content',
    text: '# Use case 05\n\nBody',
  });
  assert.equal(draftOf('mcp__docs__create_document', { title: 'x' }), null);
  assert.equal(draftOf('Write', { file_path: '/a.js', content: 'code' }), null);
  assert.equal(draftOf('mcp__docs__read_document', { content: 'x' }), null);
});

test('Postbox’s own tools are never held as writes, even one a write rule matches, such as add_dataset', async () => {
  const ask = WRITE_TOOLS.map((rule) => ({ rule, source: 'writes', unless: [] }));
  assert.ok(isWriteCall('mcp__postbox__add_dataset', {}), 'the clash this guards against');
  for (const name of ['add_dataset', ...TOOL_DEFS.map((t) => t.name)])
    assert.notEqual(decide({ call: `mcp__postbox__${name}`, rules: { deny: [], ask, allow: [] }, mode: 'ask', cwd: '/', home: '/' }).decision, 'ask', name);
  const { rt, store, t, next } = await setup();
  const answers = [];
  next.push(async (c) => answers.push(await c.askPermission({ tool: 'mcp__postbox__add_dataset', summary: 'use add dataset', input: { name: 'x' } })));
  rt.sendMessage(t.id, { text: 'Load the dataset.' });
  for (let i = 0; i < 50 && !answers.length; i++) await sleep(5);
  assert.deepEqual(answers[0], { allow: true });
  assert.equal(store.items(t.id).filter((i) => i.kind === 'permission').length, 0, 'no card');
});

test('a write’s card says where it lands: the server, and the target its input names', () => {
  assert.deepEqual(whereOf('mcp__docs__create_document', { folder: 'Use cases', content: 'x' }), {
    server: 'docs',
    target: { what: 'folder', name: 'Use cases' },
  });
  assert.deepEqual(whereOf('mcp__claude_ai_Notion__notion-create-pages', { parent: { page_id: 'abc123' } }), {
    server: 'claude.ai Notion',
    target: { what: 'parent', name: 'abc123' },
  });
  assert.deepEqual(whereOf('mcp__linear__createIssue', { title: 'x' }), { server: 'linear', target: null });
  assert.deepEqual(whereOf('Bash', { command: 'gh issue create -R HJeon139/postbox --title x' }), {
    server: 'gh',
    target: { what: 'repository', name: 'HJeon139/postbox' },
  });
});

test('#296 a git push is a write outside: it asks in every mode but Run everything, and its card names the remote', () => {
  for (const command of ['git push', 'git push -u origin feat/now', 'npm test && git push origin HEAD', 'git push --force-with-lease'])
    assert.ok(isWriteCall('Bash', { command }), command);
  for (const command of ['git status', 'git commit -m "push the fix"', 'git log origin/main..HEAD', 'echo git push'])
    assert.ok(!isWriteCall('Bash', { command }), command);
  const ask = WRITE_TOOLS.map((rule) => ({ rule, source: 'writes', unless: [] }));
  const where = { mode: 'auto', cwd: '/w', home: '/h' };
  assert.equal(decide({ call: 'Bash(git push -u origin feat/now)', rules: { deny: [], ask, allow: [] }, ...where }).decision, 'ask');
  assert.deepEqual(whereOf('Bash', { command: 'git push -u origin feat/now' }), { server: 'git', target: { what: 'remote', name: 'origin' } });
  assert.deepEqual(whereOf('Bash', { command: 'git push' }), { server: 'git', target: null });
  // --repo names where a push lands; a chain that also writes with gh says both.
  assert.deepEqual(whereOf('Bash', { command: 'git push --repo=other origin' }), { server: 'git', target: { what: 'remote', name: 'other' } });
  assert.deepEqual(whereOf('Bash', { command: 'git push -u origin feat/now && gh pr create -R HJeon139/postbox --title x --body y' }), {
    server: 'git',
    target: { what: 'remote', name: 'origin' },
    also: [{ server: 'gh', target: { what: 'repository', name: 'HJeon139/postbox' } }],
  });
});

test('the panel’s effective view: a write asks, unless an Always allow names that tool, or the persona may publish it', () => {
  const ask = WRITE_TOOLS.map((rule) => ({ rule, source: 'writes', unless: [] }));
  const where = { mode: 'auto', cwd: '/w', home: '/h' };
  const v = decide({ call: 'mcp__docs__create_document', rules: { deny: [], ask, allow: [] }, ...where });
  assert.equal(v.decision, 'ask');
  assert.equal(v.source, 'writes');
  // A whole server allowed (for its reads, say) doesn’t let its writes through; the tool itself does.
  assert.equal(
    decide({ call: 'mcp__docs__create_document', rules: { deny: [], ask, allow: [{ rule: 'mcp__docs', source: 'user' }] }, ...where }).decision,
    'ask',
  );
  const exact = decide({
    call: 'mcp__docs__create_document',
    rules: { deny: [], ask, allow: [{ rule: 'mcp__docs__create_document', source: 'local' }] },
    ...where,
  });
  assert.equal(exact.decision, 'allow');
  const publish = ask.map((r) => ({ ...r, unless: ['mcp__claude_ai_*__create'] }));
  assert.notEqual(decide({ call: 'mcp__claude_ai_Claude_Docs__create', rules: { deny: [], ask: publish, allow: [] }, ...where }).decision, 'ask');
  // gh: Bash on its own isn’t enough; a rule with the command is.
  const gh = 'Bash(gh issue create --title x)';
  assert.equal(decide({ call: gh, rules: { deny: [], ask, allow: [{ rule: 'Bash', source: 'user' }] }, ...where }).decision, 'ask');
  assert.equal(decide({ call: gh, rules: { deny: [], ask, allow: [{ rule: 'Bash(gh issue:*)', source: 'local' }] }, ...where }).decision, 'allow');
});

/** A Claude Code agent whose turns the test scripts, working in a temp folder. */
async function setup(persona = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pb-writes-'));
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
  const p = rt.createPersona({ handle: 'researcher', backend: 'claude-code', permissionMode: 'auto', tools: ['shell'], ...persona });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { rt, store, t, folder, next };
}
const create = {
  tool: 'mcp__docs__create_document',
  summary: 'use create document from docs',
  detail: '{}',
  input: { folder: 'Use cases', title: '05 · Search', content: '# 05 · Search\n\n## Problem\n\nRunbooks are hard to find.' },
};

test('a write outside Postbox waits on a card that shows its draft; Always allow for that tool lets the next one through', async () => {
  const { rt, store, t, next } = await setup();
  const answers = [];
  next.push(async (c) => answers.push(await c.askPermission(create)));
  rt.sendMessage(t.id, { text: 'Define the use case document in the team folder.' });
  // Until the card is there, not a fixed 30 ms: under load it hadn’t been posted yet (gpt’s gate run).
  for (let i = 0; i < 200 && !store.items(t.id).some((i) => i.kind === 'permission'); i++) await sleep(10);
  const card = store.items(t.id).find((i) => i.kind === 'permission');
  assert.equal(card.outside, true);
  assert.deepEqual(card.draft, { field: 'content', text: create.input.content });
  // The other arguments, with the draft’s field pointing up at it.
  assert.match(card.detail, /"title": "05 · Search"/);
  assert.match(card.detail, /"content": "\(the draft above\)"/);
  assert.equal(card.always.saves, 'mcp__docs__create_document');
  await rt.act(t.id, card.id, 'always', {});
  for (let i = 0; i < 50 && rt.turns.size; i++) await sleep(5);
  assert.equal(answers[0].allow, true);
  // Claude Code still asks (ask beats allow), and Postbox lets it through without a card.
  next.push(async (c) => answers.push(await c.askPermission(create)));
  rt.sendMessage(t.id, { text: 'And another.' });
  for (let i = 0; i < 50 && answers.length < 2; i++) await sleep(5);
  assert.deepEqual(answers[1], { allow: true });
  assert.equal(store.items(t.id).filter((i) => i.kind === 'permission').length, 1);
});

test('a write the persona may publish runs without a card; one with only its server allowed still asks', async () => {
  const pub = await setup({ canPublish: true });
  const answers = [];
  pub.next.push(async (c) =>
    answers.push(await c.askPermission({ tool: 'mcp__claude_ai_Claude_Docs__create', summary: 'use create', input: { title: 'x', markdown: '# x' } })),
  );
  pub.rt.sendMessage(pub.t.id, { text: 'Publish it.' });
  for (let i = 0; i < 50 && !answers.length; i++) await sleep(5);
  assert.deepEqual(answers[0], { allow: true });
  assert.equal(pub.store.items(pub.t.id).filter((i) => i.kind === 'permission').length, 0);

  const server = await setup();
  await writeFile(join(server.folder, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['mcp__docs'] } }));
  server.next.push(async (c) => c.askPermission(create));
  server.rt.sendMessage(server.t.id, { text: 'Create it.' });
  // The same fixed wait as above, the same fix: until the call is waiting on its card. Only then does counting the
  // cards say there is one: a duplicate posted a moment later would show by then (critic’s read).
  for (let i = 0; i < 200 && !(server.store.items(server.t.id).some((i) => i.kind === 'permission') && server.rt.permissionWaits.size === 1); i++)
    await sleep(10);
  assert.equal(server.store.items(server.t.id).filter((i) => i.kind === 'permission' && i.outside).length, 1);
});

test('a gh write after a quoted heredoc gets its card, even beside a write the person already allowed', async () => {
  const { rt, store, t, folder, next } = await setup();
  await writeFile(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(gh issue comment:*)'] } }));
  const notes = "cat > notes.md <<'EOF'\ndon't\nEOF\ngh pr create --title x";
  const answers = [];
  next.push(async (c) => {
    for (const command of [`gh issue comment 1 --body x && ${notes}`, notes])
      answers.push(await c.askPermission({ tool: 'Bash', summary: 'run a command', input: { command } }));
  });
  rt.sendMessage(t.id, { text: 'Note it, comment on the issue and open the pull request.' });
  const card = () => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
  for (const n of [0, 1]) {
    for (let i = 0; i < 50 && !card() && answers.length <= n; i++) await sleep(5);
    // Only the comment is allowed: the pull request still waits for the person, on a card that says it writes outside.
    assert.deepEqual([card()?.outside, card()?.where], [true, { server: 'gh', target: null }], `answers: ${JSON.stringify(answers)}`);
    await rt.act(t.id, card().id, 'deny', {});
  }
});

test('a Codex write shows its draft too, without an input to edit (Codex can’t run an edited call)', async () => {
  let req;
  await codexApproval(
    {
      askPermission: async (r) => {
        req = r;
        return { allow: false };
      },
    },
    {
      id: 7,
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'docs', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'create_document', tool_params: { content: '# Hi' } } },
    },
  );
  assert.deepEqual(req.draft, { field: 'content', text: '# Hi' });
  assert.equal(req.input, undefined);
});
