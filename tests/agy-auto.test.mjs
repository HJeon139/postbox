// What Postbox’s Antigravity hook approves on its own in Auto (server/adapters/agy-auto.mjs): routine commands, web
// searches, public fetches and MCP tools that don’t write run without a card; everything else still asks, and Ask me
// and Accept edits are unchanged.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicFetch, words } from '../server/adapters/agy-auto.mjs';
import { decideAgyTool, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { agyArgs, modeArgs } from '../server/adapters/antigravity-cli.mjs';
import { modeHelp, PERMISSIONS } from '../shared/agent-facts.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'pb-agy-auto-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, '.agents', 'plugins', 'postbox'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  mkdirSync(home);
  symlinkSync(join(root, 'outside'), join(ws, 'link'));
  const call = (name, args, mode = 'auto') => decideAgyTool({ toolCall: { name, args } }, { mode, folders: [ws], cwd: ws, home });
  return { root, ws, home, call };
}

const ROUTINE = [
  'ls -la',
  'pwd',
  'git status',
  'git log --oneline -5 | head -3',
  'git diff origin/main..HEAD',
  'git add . && git commit -m "fix: the parser"',
  'git branch --show-current',
  'npm test',
  'gh issue list --state open --limit 10',
  'gh pr view 415 --json title',
  'npm run check 2>&1',
  'grep -rn "TODO" src/*.js',
  "find . -name '*.md'",
  'mkdir -p out && touch out/a.txt',
  'cat src/a.js | wc -l',
  'cd src && ls',
  'cat README.md 2>/dev/null',
];

const ASKS = [
  ['ls ..', 'climbs out of the folder'],
  ['cat /etc/passwd', 'an absolute path outside'],
  ['cat ~/.ssh/id_rsa', 'the home folder'],
  ['cat link/secret', 'a link that leads out'],
  ['cp src/*.js out/', 'a write with a glob'],
  ['cp src/a.js link/', 'a write through a link'],
  ['find . -exec rm {} +', 'find that runs a program'],
  ['find . -delete', 'find that deletes'],
  ['rg --pre=sh foo', 'rg that runs a program'],
  ['rm -rf src', 'a delete'],
  ['curl https://example.com', 'the network'],
  ['echo hi > out.txt', 'a redirect'],
  ['cat $(ls)', 'a substitution'],
  ['echo "$HOME"', 'an expansion in quotes'],
  ['git push', 'git that leaves the computer'],
  ['gh issue create --title x', 'gh that writes'],
  ['gh api repos/x/y -X DELETE', 'gh api, which can write'],
  ['git commit --amend', 'git that rewrites a commit'],
  ['git branch -D old', 'git that deletes a branch'],
  ['git -C /tmp status', 'git in another folder'],
  ['cd', 'a cd that goes home'],
  ['cd src && cat ../../x', 'a climb after cd'],
  ['FOO=1 ls', 'an assignment'],
  ['npx tsc', 'npx, which can download'],
  ['node script.mjs', 'a program'],
  ['sudo ls', 'sudo'],
  ['ls "unclosed', 'a quote that never ends'],
  ['', 'nothing'],
];

test('Auto runs routine commands in the agent’s folders without a card', () => {
  const { call } = workspace();
  for (const c of ROUTINE) assert.deepEqual(call('run_command', { CommandLine: c }), { decision: 'allow' }, c);
});

test('Auto still asks about every other command, and Ask me and Accept edits ask about all of them', () => {
  const { call } = workspace();
  for (const [c, why] of ASKS) {
    const out = call('run_command', { CommandLine: c });
    assert.equal(out.decision, 'ask', `${c}: ${why}`);
    assert.equal(out.toolName, 'Bash');
  }
  for (const mode of ['ask', 'acceptEdits'])
    for (const c of ROUTINE) assert.equal(call('run_command', { CommandLine: c }, mode).decision, 'ask', `${mode}: ${c}`);
});

test('Auto flags a command that names Antigravity’s plugin, hook or settings on its card', () => {
  const { call } = workspace();
  for (const c of ['ls .agents/plugins/postbox', 'cat ~/.gemini/antigravity-cli/settings.json', 'cat server/adapters/agy-hook.mjs']) {
    const out = call('run_command', { CommandLine: c, toolSummary: 'Look' });
    assert.equal(out.decision, 'ask', c);
    assert.match(out.input.description, /^Touches Antigravity’s plugin, hook or settings/, c);
  }
});

test('Auto allows web searches and public fetches; a query, a sign-in or a local address asks', () => {
  const { call } = workspace();
  assert.deepEqual(call('search_web', { query: 'postbox' }), { decision: 'allow' });
  assert.deepEqual(call('read_url_content', { Url: 'https://example.com/docs/a' }), { decision: 'allow' });
  for (const url of [
    'https://example.com/?q=secret',
    'https://me:pw@example.com/',
    'http://localhost:4173/',
    'http://127.0.0.1:4320/',
    'file:///etc/passwd',
    'nope',
  ])
    assert.deepEqual(call('read_url_content', { Url: url }), { decision: 'ask', toolName: 'WebFetch', input: { url } }, url);
  for (const mode of ['ask', 'acceptEdits']) {
    assert.equal(call('search_web', { query: 'postbox' }, mode).decision, 'ask', mode);
    assert.equal(call('read_url_content', { Url: 'https://example.com/docs/a' }, mode).decision, 'ask', mode);
  }
  assert.equal(publicFetch('https://example.com/a#part'), true);
});

test('Auto allows MCP tools outside Postbox that don’t write; writes still ask (#112), and permission_prompt is denied', () => {
  const { call } = workspace();
  assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'get_issue', Arguments: { number: 1 } }), { decision: 'allow' });
  assert.deepEqual(call('read_resource', { ServerName: 'docs', Uri: 'docs://a' }), { decision: 'allow' });
  assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } }), {
    decision: 'ask',
    toolName: 'mcp__github__create_issue',
    input: { title: 'Hi' },
  });
  assert.equal(call('call_mcp_tool', { ServerName: 'github', ToolName: '', Arguments: {} }).decision, 'ask');
  assert.equal(call('call_mcp_tool', { ServerName: 'github', ToolName: 'get_issue', Arguments: {} }, 'ask').decision, 'ask');
  for (const mode of ['auto', 'ask', 'acceptEdits'])
    assert.equal(call('call_mcp_tool', { ServerName: 'postbox_postbox', ToolName: 'permission_prompt', Arguments: {} }, mode).decision, 'deny', mode);
});

test('Auto keeps the hook’s file rules: edits to Antigravity’s files are denied, and reads and edits outside ask', () => {
  const { ws, root, call } = workspace();
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.agents', 'plugins', 'postbox', 'hooks.json') }).decision, 'deny');
  assert.equal(call('write_to_file', { TargetFile: join(ws, 'src', 'a.js') }).decision, 'allow');
  assert.equal(call('write_to_file', { TargetFile: join(root, 'outside', 'a.js') }).decision, 'ask');
  assert.equal(call('view_file', { AbsolutePath: join(root, 'outside', 'a.js') }).decision, 'ask');
});

test('the word reader refuses what it can’t be sure of, and drops redirects to /dev/null', () => {
  assert.deepEqual(words(`grep -n 'a b' "c d" e`), ['grep', '-n', 'a b', 'c d', 'e']);
  assert.deepEqual(words('npm test 2>&1'), ['npm', 'test']);
  assert.deepEqual(words('ls >/dev/null 2>/dev/null'), ['ls']);
  for (const part of ['echo `id`', 'ls > x', 'cat < x', 'echo \\x', 'ls & ', 'echo "a$b"', "echo 'open"]) assert.equal(words(part), null, part);
});

test('modeArgs: Auto, Ask me and Accept edits run under the hook when it’s confirmed, and their own flags when it isn’t', () => {
  const cases = {
    auto: [['--mode', 'auto'], ['--dangerously-skip-permissions']],
    ask: [[], ['--dangerously-skip-permissions']],
    acceptEdits: [['--mode', 'accept-edits'], ['--dangerously-skip-permissions']],
    bypass: [['--dangerously-skip-permissions'], ['--dangerously-skip-permissions']],
  };
  for (const [mode, [without, withHook]] of Object.entries(cases)) {
    assert.deepEqual(modeArgs({ permissionMode: mode }), without, mode);
    assert.deepEqual(modeArgs({ permissionMode: mode }, { hookConfirmed: true }), withHook, mode);
    const args = agyArgs({ persona: { permissionMode: mode }, model: 'gemini-3.8-flash-high', effort: null, prompt: 'hi', hookConfirmed: true });
    assert.ok(args.includes('--dangerously-skip-permissions') && !args.includes('--mode'), mode);
  }
});

test('the hook in Auto allows a routine command without asking Postbox, and asks for one that isn’t', async () => {
  const { ws, home } = workspace();
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'auto', POSTBOX_AGY_FOLDERS: JSON.stringify([ws]) };
  const asked = [];
  const fetchImpl = async (_url, init) => {
    asked.push(JSON.parse(init.body).params.arguments.input.command);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { content: [{ text: '{"behavior":"deny"}' }] } }),
    };
  };
  const run = (CommandLine, mode = env) =>
    runAgyHook(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine } } }), {
      cwd: ws,
      home,
      env: mode,
      fetchImpl: /** @type {any} */ (fetchImpl),
    });
  assert.deepEqual(await run('git status'), { decision: 'allow' });
  assert.equal((await run('git push')).decision, 'deny');
  assert.equal((await run('git status', { ...env, POSTBOX_AGY_MODE: 'ask' })).decision, 'deny');
  assert.deepEqual(asked, ['git push', 'git status']);
});

test('the persona sheet says Auto on Antigravity is Postbox’s own approval, and what still asks', () => {
  const help = (id) => modeHelp('antigravity-cli', /** @type {any} */ (PERMISSIONS.find(([m]) => m === id)));
  assert.match(help('auto'), /^Antigravity’s Auto: Postbox approves routine actions itself/);
  assert.match(help('auto'), /asks with a card before anything else, such as rm, git push, curl, or edits outside its folders/);
  assert.notEqual(help('auto'), help('acceptEdits'));
});
