// What Postbox’s Antigravity hook approves on its own in Auto (server/adapters/agy-auto.mjs): routine commands, gh’s
// commands that read issues and pull requests, and public fetches with no query run without a card; everything else
// still asks, and Ask me and Accept edits are unchanged.

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
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(ws, '.agents', 'plugins', 'postbox'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  mkdirSync(home);
  symlinkSync(join(root, 'outside'), join(ws, 'link'));
  const call = (name, args, mode = 'auto', cwd = ws) => decideAgyTool({ toolCall: { name, args } }, { mode, folders: [cwd], cwd, home });
  return { root, ws, home, call };
}

const ROUTINE = [
  'ls -la',
  'pwd',
  'git status',
  'git log --oneline -5 | head -3',
  'git log -n 3 --format=%H',
  'git diff origin/main..HEAD -- src',
  'git add src/a.js',
  'git branch --show-current',
  'gh issue list --state open --limit 10',
  'gh pr view 415 --json title',
  'grep -rn "TODO" src/*.js',
  'grep -rn --include=*.js TODO src',
  "find . -name '*.md' -type f",
  'mkdir -p out && touch out/a.txt',
  'cat src/a.js | wc -l',
  'sort -n -k 2 src/a.txt',
  'head -n5 src/a.js',
  'cat README.md 2>/dev/null',
];

const ASKS = [
  ['ls ..', 'climbs out of the folder'],
  ['cat /etc/passwd', 'an absolute path outside'],
  ['cat ~/.ssh/id_rsa', 'the home folder'],
  ['cat link/secret', 'a link that leads out'],
  ['cp src/*.js out/', 'a write with a glob'],
  ['cp src/a.js link/', 'a write through a link'],
  ['rm -rf src', 'a delete'],
  ['curl https://example.com', 'the network'],
  ['echo hi > out.txt', 'a redirect'],
  ['cat $(ls)', 'a substitution'],
  ['echo "$HOME"', 'an expansion in quotes'],
  ['git push', 'git that leaves the computer'],
  ['gh api repos/x/y -X DELETE', 'gh api, which can do anything'],
  ['gh pr view 1 --web', 'gh that opens a browser'],
  ['gh issue create --title "Flaky check" --body "It fails on main."', 'a gh write, which keeps its card (#112)'],
  ['gh pr comment 423 --body "Looks good."', 'a gh comment'],
  ['gh pr review 423 --approve', 'a gh review'],
  ['gh release create v1.0.0', 'a gh release'],
  ['git commit --amend', 'git that rewrites a commit'],
  ['git branch -D old', 'git that deletes a branch'],
  ['git -C /tmp status', 'git in another folder'],
  ['cd src && ls', 'cd, which moves where git looks'],
  ['FOO=1 ls', 'an assignment'],
  ['npx tsc', 'npx, which can download'],
  ['node script.mjs', 'a program'],
  ['sudo ls', 'sudo'],
  ['ls "unclosed', 'a quote that never ends'],
  ['ls --color=always', 'an option ls isn’t listed with'],
  ['', 'nothing'],
];

// #423’s review: an option that runs a program passed as routine, since only a few were listed as unsafe.
const RUNS_A_PROGRAM = [
  "git grep -O'sh -c x' foo",
  'git grep --open-files-in-pager=vim foo',
  'sort --compress-program=./x.sh src/a.txt',
  'sort -o out.txt src/a.txt',
  'rg --hostname-bin=./x foo',
  'rg --pre=sh foo',
  'rg --pre sh foo',
  'find . -exec rm {} +',
  'find . -execdir sh x ;',
  'find . -delete',
  'find . -fprint out.txt',
  'git diff --ext-diff',
  'git diff --output=x.txt',
  'git log --exec=x',
  'tree -o out.txt',
  'uniq src/a.txt out.txt',
];

// #423’s review: the agent could write code in its folder, then run it with a command that passed as routine.
const RUNS_THE_FOLDERS_CODE = [
  'npm test',
  'npm run check',
  'npm run-script build',
  'npx vitest',
  'git commit -m "fix"',
  'git add . && git commit -m x',
  'make',
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

test('Auto asks about an option it doesn’t list for a command, so one that runs a program can’t pass as routine', () => {
  const { call } = workspace();
  for (const c of RUNS_A_PROGRAM) assert.equal(call('run_command', { CommandLine: c }).decision, 'ask', c);
});

test('Auto asks before npm, npx, make and git commit, which run code in the folder the agent could have written', () => {
  const { call } = workspace();
  for (const c of RUNS_THE_FOLDERS_CODE) assert.equal(call('run_command', { CommandLine: c }).decision, 'ask', c);
});

test('Auto asks before an edit in .git, and before git where the folder’s .git isn’t a real folder', () => {
  const { root, ws, call } = workspace();
  for (const target of [join(ws, '.git', 'config'), join(ws, '.git', 'hooks', 'pre-commit'), join(ws, 'src', '.git')])
    for (const tool of ['write_to_file', 'replace_file_content']) assert.equal(call(tool, { TargetFile: target }).decision, 'ask', `${tool} ${target}`);
  assert.equal(call('write_to_file', { TargetFile: join(ws, '.git', 'config') }, 'acceptEdits').decision, 'allow');
  for (const c of ['cp src/x .git/config', 'touch .git/hooks/pre-commit', 'mv src/x .git/hooks/post-checkout', 'git add .git/config'])
    assert.equal(call('run_command', { CommandLine: c }).decision, 'ask', c);
  // A folder with no .git, which git would read as a bare repository from files the agent wrote, or a .git link.
  const bare = join(root, 'bare');
  mkdirSync(join(bare, 'objects'), { recursive: true });
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync(join(ws, '.git'), join(linked, '.git'));
  for (const cwd of [bare, linked]) assert.equal(call('run_command', { CommandLine: 'git status' }, 'auto', cwd).decision, 'ask', cwd);
  assert.equal(call('run_command', { CommandLine: 'ls' }, 'auto', bare).decision, 'allow');
});

test('Auto flags a command that names Antigravity’s plugin, hook or settings on its card', () => {
  const { call } = workspace();
  for (const c of ['ls .agents/plugins/postbox', 'cat ~/.gemini/antigravity-cli/settings.json', 'cat server/adapters/agy-hook.mjs']) {
    const out = call('run_command', { CommandLine: c, toolSummary: 'Look' });
    assert.equal(out.decision, 'ask', c);
    assert.match(out.input.description, /^Touches Antigravity’s plugin, hook or settings/, c);
  }
});

// #423’s re-review: macOS’s file system ignores case, so .GIT/config is .git/config, and .AGENTS/plugins is the
// plugin. An exact match let an edit there through.
test('Auto asks before an edit in .git in any letter case, and the hook’s own files are denied in any case', () => {
  const { ws, home, call } = workspace();
  for (const target of [join(ws, '.GIT', 'config'), join(ws, '.Git', 'hooks', 'x')])
    for (const tool of ['write_to_file', 'replace_file_content']) assert.equal(call(tool, { TargetFile: target }).decision, 'ask', `${tool} ${target}`);
  for (const c of ['cp src/x .GIT/config', 'mv src/x .Git/hooks/x', 'touch .gIt/hooks/pre-commit'])
    assert.equal(call('run_command', { CommandLine: c }).decision, 'ask', c);
  for (const target of [join(ws, '.AGENTS', 'plugins', 'postbox', 'hooks.json'), join(home, '.GEMINI', 'Antigravity-CLI', 'settings.json')])
    for (const mode of ['auto', 'ask', 'acceptEdits']) assert.equal(call('write_to_file', { TargetFile: target }, mode).decision, 'deny', `${mode} ${target}`);
  const flagged = call('run_command', { CommandLine: 'cat .AGENTS/plugins/postbox/hooks.json', toolSummary: 'Look' });
  assert.match(flagged.input.description, /^Touches Antigravity’s plugin, hook or settings/);
});

// #423’s re-review: jq’s env, and gh’s --jq, which is jq too, print the environment, tokens included.
test('Auto asks before jq and gh --jq, which can print the environment', () => {
  const { call } = workspace();
  for (const c of ['jq -n env', 'jq . src/a.json', 'gh pr view 1 --json title --jq env', 'gh pr view 1 --json title -q env', 'gh issue list --jq=env'])
    assert.equal(call('run_command', { CommandLine: c }).decision, 'ask', c);
});

// #423’s review: a search, or a fetch’s path, subdomain or query, can carry data out. On review the maintainer kept
// query-free fetches, and sent searches and a query or fragment on to the reviewer or the card; this computer and a
// sign-in in the address ask too.
test('Auto allows public fetches without a query or fragment; a search, a query, a fragment, a sign-in or a local address asks', () => {
  const { call } = workspace();
  assert.equal(call('search_web', { query: 'postbox secret-token-1234' }).decision, 'ask');
  for (const url of ['https://example.com/docs/a', 'https://secret.example.com/', 'https://example.com/secret/path'])
    assert.deepEqual(call('read_url_content', { Url: url }), { decision: 'allow' }, url);
  for (const url of [
    'https://example.com/?q=secret',
    'https://example.com/a#d=secret',
    'https://me:pw@example.com/',
    'http://localhost:4173/',
    'http://127.0.0.1:4320/',
    'http://[::1]:4173/',
    'file:///etc/passwd',
    'nope',
  ])
    assert.deepEqual(call('read_url_content', { Url: url }), { decision: 'ask', toolName: 'WebFetch', input: { url } }, url);
  for (const mode of ['ask', 'acceptEdits']) {
    assert.equal(call('search_web', { query: 'postbox' }, mode).decision, 'ask', mode);
    assert.equal(call('read_url_content', { Url: 'https://example.com/docs/a' }, mode).decision, 'ask', mode);
  }
  assert.equal(publicFetch('https://example.com/a#part'), false);
  assert.equal(publicFetch('https://example.com/a?'), true, 'an empty query carries nothing');
});

test('Auto approves no MCP tool outside Postbox by rule: each asks, for the reviewer or the card (#416, #112); permission_prompt is denied', () => {
  const { call } = workspace();
  assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'get_issue', Arguments: { number: 1 } }), {
    decision: 'ask',
    toolName: 'mcp__github__get_issue',
    input: { number: 1 },
  });
  assert.deepEqual(call('read_resource', { ServerName: 'docs', Uri: 'docs://a' }), { decision: 'allow' });
  for (const mode of ['auto', 'ask', 'acceptEdits'])
    assert.deepEqual(call('call_mcp_tool', { ServerName: 'github', ToolName: 'create_issue', Arguments: { title: 'Hi' } }, mode), {
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
  assert.match(help('auto'), /^Antigravity’s Auto: Postbox approves routine actions itself, since agy’s own Auto isn’t available on this account/);
  assert.match(
    help('auto'),
    /It asks with a card before anything else, such as rm, git commit, npm test, curl, a web search, a fetch with a query, an MCP tool, edits in \.git, edits outside its folders, or a write outside Postbox/,
  );
  assert.doesNotMatch(help('auto'), /searches the web/);
  // It doesn’t name a command as routine that could run what a script says (#423’s review).
  assert.doesNotMatch(/everyday commands there \(([^)]*)\)/.exec(help('auto'))?.[1] ?? 'missing npm', /npm|commit/);
  assert.notEqual(help('auto'), help('acceptEdits'));
});
