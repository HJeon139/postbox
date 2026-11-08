// `- seed: git-remote` (#305, #296): a remote the run’s agents can commit and push to over and over, that is nothing
// but a bare repository in the run’s own folder, gone when the run stops. What keeps an agent’s ordinary pushes and
// PRs on this computer:
// - every git that Postbox and its agents run gets GIT_ALLOW_PROTOCOL=file, which git applies over any config file,
//   per-protocol settings included, and protocol.allow=never with only file allowed, from the environment
//   (GIT_CONFIG_COUNT) and again from the workspace’s own .git/config. So an https, ssh or git:// remote is refused
//   before anything leaves this computer;
// - git reads the run’s own config, not the person’s: GIT_CONFIG_GLOBAL is a file in the run’s folder that holds only a
//   test identity, and GIT_CONFIG_NOSYSTEM drops the system’s, such as Homebrew’s. So no pushInsteadOf, insteadOf,
//   include, hook or credential helper of theirs touches an agent’s push;
// - a fake gh comes first on PATH, and records what it was asked; gh’s config folder is an empty one of the run’s, and
//   the gh tokens are empty. Claude Code sources CLAUDE_ENV_FILE in the agent’s shell after its profile, which on a Mac
//   puts Homebrew’s gh back first, so that file puts the run’s bin first again;
// - preflightRun checks it on the environment the runner gives Postbox, which the agents inherit, and the run stops
//   before Postbox starts if any of it doesn’t hold;
// - the project’s repository, where Postbox makes a push itself (server/push-on-request.mjs), is the bare repository,
//   and the run stops before any agent turn if it can’t be set (setUpRemote). That push doesn’t read the guard: it
//   runs git with none of the environment’s config and turns https and ssh back on. What it keeps is PATH, so its
//   credential helper is the fake gh, gh’s config folder, which is the run’s empty one, and SSH_AUTH_SOCK, which the
//   run blanks. So for Postbox’s own push, the repository setting is the guard, with no credentials behind it.
// What’s left, so no one reads this as containment: the guard is environment the agent’s own shell inherits, so it
// stops an agent that pushes because the scenario told it to, not one set on reaching a remote. Such an agent can:
// - undo it: `env -u GIT_ALLOW_PROTOCOL git push …`, `GIT_ALLOW_PROTOCOL=https git push …`, or `env -i`, then
//   `git -c protocol.allow=always …`. In Ask me or Accept edits that command comes to a card first; in Auto, the
//   harness decides;
// - skip git: a real gh called by its full path still reads the person’s sign-in from the keychain (`gh auth token`),
//   since HOME and the keyring are theirs, and `curl` with that token reaches GitHub;
// - a file push can reach a bare repository outside the run’s folder, and nothing refuses `--host` for this seed: the
//   seed is for local runs only.
// Postbox’s temp folders (pb-*) go in the run’s tmp folder, so the end of the run can say none is left.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { js } from '../browser.mjs';

/** What every git in the run reads: no transport but local paths. */
export const GUARD = [
  ['protocol.allow', 'never'],
  ['protocol.file.allow', 'always'],
];
/** An https remote nothing listens on, refused at once: the preflight’s probe, and the tests’. */
export const UNREACHABLE = 'https://127.0.0.1:9/uat/none.git';

/** The run’s folders and files for the remote. @param {string} dir  the run’s folder */
export const remotePaths = (dir) => ({
  remote: join(dir, 'remote.git'),
  bin: join(dir, 'bin'),
  ghConfig: join(dir, 'gh-config'),
  ghCalls: join(dir, 'gh-calls.jsonl'),
  envFile: join(dir, 'agent-env.sh'),
  gitconfig: join(dir, 'gitconfig'),
  tmp: join(dir, 'tmp'),
  record: join(dir, 'remote.json'),
});

/** git with these arguments, under env (the runner’s own, with the guard, unless the preflight gives the run’s). */
const gitRun = (args, cwd, env = { ...process.env, ...guardEnv() }) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, env });
/** git’s stdout, trimmed, or null when it fails. */
function git(args, cwd) {
  const r = gitRun(args, cwd);
  return r.status === 0 ? r.stdout.trim() : null;
}
/** git that must work: a seed step that fails stops the run, naming the step and what git said. */
function mustGit(args, cwd) {
  const r = gitRun(args, cwd);
  if (r.status !== 0) throw new Error(`Couldn’t seed the run’s remote: git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
}

/** The guard as environment: git reads GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n over every config file. */
export function guardEnv() {
  const env = { GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: String(GUARD.length) };
  GUARD.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

// The fake gh: each call is one JSON line of its arguments, and `gh pr create` answers with a link that goes nowhere.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.POSTBOX_UAT_GH_CALLS, JSON.stringify({ at: Date.now(), args }) + '\\n');
if (args[0] === 'pr' && args[1] === 'create') console.log('https://example.invalid/uat/pull/' + Date.now());
`;

/**
 * Postbox’s environment for a `- seed: git-remote` run, which its agents inherit; nothing for any other seed.
 * @param {{ seed: string|null }} scenario @param {string} dir
 * @returns {Record<string, string>}
 */
export function gitRemoteEnv(scenario, dir) {
  if (scenario.seed !== 'git-remote') return {};
  const p = remotePaths(dir);
  return {
    ...guardEnv(),
    GIT_CONFIG_GLOBAL: p.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${p.bin}:${process.env.PATH ?? ''}`,
    GH_CONFIG_DIR: p.ghConfig,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    // No ssh agent, so even Postbox’s own push, which keeps SSH_AUTH_SOCK, has no key for an ssh remote. A git-remote
    // run is local only: Postbox reaches a host over ssh.
    SSH_AUTH_SOCK: '',
    POSTBOX_UAT_GH_CALLS: p.ghCalls,
    CLAUDE_ENV_FILE: p.envFile,
    TMPDIR: p.tmp,
  };
}

/**
 * Makes the bare remote, points the workspace’s origin at it, and puts the guard in the workspace’s config and the
 * fake gh in the run’s bin. The bare repository logs every update of a ref, so each push can be counted.
 * @param {string} workspace @param {string} dir
 */
export function seedGitRemote(workspace, dir) {
  const p = remotePaths(dir);
  for (const d of [p.bin, p.ghConfig, p.tmp]) mkdirSync(d, { recursive: true });
  mustGit(['init', '-q', '--bare', '-b', 'main', p.remote]);
  mustGit(['-C', p.remote, 'config', 'core.logAllRefUpdates', 'always']);
  for (const [k, v] of GUARD) mustGit(['-C', workspace, 'config', k, v]);
  mustGit(['-C', workspace, 'remote', 'add', 'origin', p.remote]);
  // What an agent’s `git add` mustn’t sweep in: its own settings, which Postbox writes, and Python’s caches.
  writeFileSync(join(workspace, '.gitignore'), '.claude/\n__pycache__/\n*.pyc\n');
  writeFileSync(join(p.bin, 'gh'), FAKE_GH);
  chmodSync(join(p.bin, 'gh'), 0o755);
  writeFileSync(p.ghCalls, '');
  writeFileSync(p.envFile, agentEnvFile(p));
  // The run’s own global config, in place of the person’s: only an identity for the agents’ commits.
  writeFileSync(p.gitconfig, '[user]\n\tname = UAT developer\n\temail = uat@example.invalid\n');
}

const quoted = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
/** What Claude Code sources in the agent’s shell after its profile: the run’s bin first again, and gh with no login. */
const agentEnvFile = (p) =>
  [
    `export PATH=${quoted(p.bin)}:"$PATH"`,
    `export GH_CONFIG_DIR=${quoted(p.ghConfig)} GIT_CONFIG_GLOBAL=${quoted(p.gitconfig)} GIT_CONFIG_NOSYSTEM=1`,
    "export GH_TOKEN='' GITHUB_TOKEN='' SSH_AUTH_SOCK='' GIT_ALLOW_PROTOCOL=file",
    '',
  ].join('\n');

/**
 * A `- seed: git-remote` run’s guard, checked before Postbox starts on env, the environment the runner gives Postbox
 * (process.env and runEnv), which the agents inherit. Nothing for any other seed.
 * @param {{ seed: string|null }} scenario @param {string} workspace @param {string} dir @param {Record<string, string|undefined>} env
 */
export function preflightRun(scenario, workspace, dir, env) {
  if (scenario.seed === 'git-remote') preflightRemote(workspace, dir, env);
}

/**
 * The guard, checked under the run’s own environment: origin is the run’s remote, git there is
 * refused an https remote, and gh in a shell like the agent’s (the person’s login shell, then CLAUDE_ENV_FILE) is the
 * fake. Throws, so the run stops, when any of it doesn’t hold.
 * @param {string} workspace @param {string} dir @param {Record<string, string|undefined>} env  the run’s environment
 */
export function preflightRemote(workspace, dir, env) {
  const p = remotePaths(dir);
  const stop = (what) => new Error(`${what}, so the run stops before any agent turn.`);
  const origin = gitRun(['-C', workspace, 'remote', 'get-url', 'origin'], undefined, env).stdout?.trim();
  if (origin !== p.remote) throw stop(`origin is ${origin || 'unset'}, not the run’s remote (${p.remote})`);
  const probe = gitRun(['-C', workspace, 'ls-remote', UNREACHABLE], undefined, { ...env, GIT_TERMINAL_PROMPT: '0' });
  if (!/transport 'https' not allowed/.test(probe.stderr ?? ''))
    throw stop(`git in the run isn’t refused an https remote (it said: ${(probe.stderr ?? '').trim().slice(0, 200)})`);
  const shell = env.SHELL || '/bin/sh';
  const which = spawnSync(shell, ['-lic', '[ -n "$CLAUDE_ENV_FILE" ] && . "$CLAUDE_ENV_FILE"; command -v gh'], { env, encoding: 'utf8', timeout: 20_000 });
  const gh = (which.stdout ?? '').trim().split('\n').at(-1);
  if (gh !== join(p.bin, 'gh')) throw stop(`gh in the agent’s shell is ${gh || 'missing'}, not the run’s fake (${join(p.bin, 'gh')})`);
}

/**
 * What the tester is told of the remote, for a `- seed: git-remote` run: where it is, and that nothing else can be
 * reached. @param {{ seed: string|null }} scenario @param {string} dir
 */
export function remoteNote(scenario, dir) {
  if (scenario.seed !== 'git-remote') return '';
  return `\n\nThis run’s remote is the folder ${remotePaths(dir).remote}, a bare repository the run made and removes at its end. The project folder’s origin points at it, and so does the project’s repository in Settings, where Postbox makes a push you asked for itself. Every git here is refused any other remote, and the gh on the agent’s PATH is a fake.`;
}

/**
 * Sets the project’s repository to the run’s remote, through the page as Settings does (PUT push-url, with the page’s
 * token), so a push the person asks for in Auto goes there (server/push-on-request.mjs). Then the note for the tester.
 * The first run of the gitpush scenario showed a tester can’t be relied on to find the setting. Throws when it doesn’t
 * take, so the run stops.
 * @param {{ seed: string|null }} scenario
 * @param {{ dir: string, page: { evaluate: (expr: string) => Promise<any> }, threadId: string, log: (line: string) => void }} o
 */
export async function setUpRemote(scenario, { dir, page, threadId, log }) {
  if (scenario.seed !== 'git-remote') return '';
  const set = `import('/app/js/client.mjs').then(async ({ api, S }) => { const id = S().threads[${js(threadId)}].projectId; const p = await api('/api/projects/' + id + '/push-url', { url: ${js(remotePaths(dir).remote)} }, 'PUT'); return p.pushUrl; }).catch((e) => 'an error: ' + e.message)`;
  const url = await page.evaluate(set);
  // Fail closed: with any other repository, a push the person asks for would go wherever the project points.
  if (url !== remotePaths(dir).remote)
    throw new Error(`Couldn’t set the project’s repository to the run’s remote (it reads ${url}), so the run stops before any agent turn.`);
  log('The project’s repository is the run’s remote.');
  return remoteNote(scenario, dir);
}

/** Each update the remote took, oldest first: the branch, and the commit it moved to. */
function pushesOf(remote) {
  const refs = git(['-C', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads']);
  const out = [];
  for (const ref of refs ? refs.split('\n').filter(Boolean) : []) {
    // %gd with --date=unix is the update’s own time, as refs/heads/main@{1762560000}.
    const log = git(['-C', remote, 'reflog', 'show', '--date=unix', '--format=%H %gd', ref]) ?? '';
    for (const line of log.split('\n').filter(Boolean).reverse()) {
      const [sha, when] = line.split(' ');
      out.push({ branch: ref.replace('refs/heads/', ''), sha, at: Number(/@\{(\d+)\}/.exec(when)?.[1] ?? 0) * 1000 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What the gh calls were, from the fake gh’s record. */
function ghCallsOf(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The work ledger of the run’s conversations: its entries, its push entries, and its bytes. */
function ledgerOf(state, threads) {
  const entries = (threads ?? []).flatMap((id) => state?.work?.[id] ?? []);
  return { entries: entries.length, ledgerPushes: entries.filter((e) => e.kind === 'push').length, ledgerBytes: JSON.stringify(entries).length };
}

/**
 * What the remote holds now, with one sample of the ledger’s and the state’s size beside it (#305), kept in
 * remote.json so --recheck reads it once the remote is gone. With no remote, what remote.json kept.
 * @param {string} dir @param {{ state?: any, threads?: any[] }} [now]
 */
export function remoteFacts(dir, now = {}) {
  const p = remotePaths(dir);
  const kept = existsSync(p.record) ? JSON.parse(readFileSync(p.record, 'utf8')) : { samples: [] };
  if (!existsSync(p.remote)) return kept;
  const pushes = pushesOf(p.remote);
  const sample = now.state
    ? { at: Date.now(), pushes: pushes.length, ...ledgerOf(now.state, now.threads), stateBytes: JSON.stringify(now.state).length }
    : null;
  const facts = { pushes, gh: ghCallsOf(p.ghCalls), samples: sample ? [...kept.samples, sample] : kept.samples };
  writeFileSync(p.record, `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
}

/** What of the remote’s is left in the run’s folder: the bare repository, and Postbox’s pb-* temp folders. */
export function leftovers(dir) {
  const p = remotePaths(dir);
  const temps = existsSync(p.tmp) ? readdirSync(p.tmp).filter((n) => n.startsWith('pb-')) : [];
  return [...(existsSync(p.remote) ? ['remote.git'] : []), ...temps.map((n) => `tmp/${n}`)];
}

/**
 * The end of a `- seed: git-remote` run: the remote’s facts kept, then the bare repository and the run’s temp folder
 * removed, and what’s left said. Only ever a path inside the run’s folder.
 * @param {string} dir @param {(line: string) => void} log  @returns {string[] | undefined}  what was left
 */
export function tearDownRemote(dir, log) {
  const p = remotePaths(dir);
  if (!existsSync(p.remote)) return;
  remoteFacts(dir);
  // Postbox removes its own pb-* folders after a push; one still there before the run removes the rest is a finding.
  const postboxLeft = leftovers(dir).filter((n) => n.startsWith('tmp/'));
  const inside = (path) => resolve(path).startsWith(resolve(dir) + sep);
  for (const path of [p.remote, p.tmp]) if (inside(path)) rmSync(path, { recursive: true, force: true });
  const left = [...postboxLeft.map((n) => `${n} (Postbox’s, before the run removed it)`), ...leftovers(dir)];
  log(left.length ? `Left after the run: ${left.join(', ')}.` : 'The run’s remote and temp folders are removed, and Postbox left no pb-* folder.');
  return left;
}
