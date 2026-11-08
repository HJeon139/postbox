// `- seed: git-remote` (#305, #296): a remote the run’s agents can commit and push to over and over, that is nothing
// but a bare repository in the run’s own folder, gone when the run stops. Nothing in the run can reach a real remote
// or a real gh:
// - every git that Postbox and its agents run takes protocol.allow=never with only file allowed, from the environment
//   (GIT_CONFIG_COUNT) and again from the workspace’s own .git/config, so an https, ssh or git:// remote is refused
//   before anything leaves this computer;
// - a fake gh comes first on PATH, and records what it was asked; gh’s config folder is an empty one of the run’s, so a
//   real gh found another way has no login;
// - the project’s repository, where Postbox makes a push itself (server/push-on-request.mjs), is the bare repository.
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

/** The run’s folders and files for the remote. @param {string} dir  the run’s folder */
export const remotePaths = (dir) => ({
  remote: join(dir, 'remote.git'),
  bin: join(dir, 'bin'),
  ghConfig: join(dir, 'gh-config'),
  ghCalls: join(dir, 'gh-calls.jsonl'),
  tmp: join(dir, 'tmp'),
  record: join(dir, 'remote.json'),
});

/** git with only the guard and these arguments; its stdout, trimmed, or null when it fails. */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...guardEnv() } });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The guard as environment: git reads GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n over every config file. */
export function guardEnv() {
  const env = { GIT_CONFIG_COUNT: String(GUARD.length) };
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
    PATH: `${p.bin}:${process.env.PATH ?? ''}`,
    GH_CONFIG_DIR: p.ghConfig,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    POSTBOX_UAT_GH_CALLS: p.ghCalls,
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
  git(['init', '-q', '--bare', '-b', 'main', p.remote]);
  git(['-C', p.remote, 'config', 'core.logAllRefUpdates', 'always']);
  for (const [k, v] of GUARD) git(['-C', workspace, 'config', k, v]);
  git(['-C', workspace, 'remote', 'add', 'origin', p.remote]);
  // What an agent’s `git add` mustn’t sweep in: its own settings, which Postbox writes, and Python’s caches.
  writeFileSync(join(workspace, '.gitignore'), '.claude/\n__pycache__/\n*.pyc\n');
  writeFileSync(join(p.bin, 'gh'), FAKE_GH);
  chmodSync(join(p.bin, 'gh'), 0o755);
  writeFileSync(p.ghCalls, '');
}

/**
 * What the tester is told of the remote, for a `- seed: git-remote` run: where it is, and that nothing else can be
 * reached. @param {{ seed: string|null }} scenario @param {string} dir
 */
export function remoteNote(scenario, dir) {
  if (scenario.seed !== 'git-remote') return '';
  return `\n\nThis run’s remote is the folder ${remotePaths(dir).remote}, a bare repository the run made and removes at its end. The project folder’s origin points at it, and so does the project’s repository in Settings, where Postbox makes a push you asked for itself. No other remote and no real gh can be reached from this run.`;
}

/**
 * Sets the project’s repository to the run’s remote, through the page as Settings does (PUT push-url, with the page’s
 * token), so a push the person asks for in Auto goes there (server/push-on-request.mjs). Then the note for the tester.
 * The first run of the gitpush scenario showed a tester can’t be relied on to find the setting.
 * @param {{ seed: string|null }} scenario
 * @param {{ dir: string, page: { evaluate: (expr: string) => Promise<any> }, threadId: string, log: (line: string) => void }} o
 */
export async function setUpRemote(scenario, { dir, page, threadId, log }) {
  if (scenario.seed !== 'git-remote') return '';
  const set = `import('/app/js/client.mjs').then(async ({ api, S }) => { const id = S().threads[${js(threadId)}].projectId; const p = await api('/api/projects/' + id + '/push-url', { url: ${js(remotePaths(dir).remote)} }, 'PUT'); return p.pushUrl; }).catch((e) => 'an error: ' + e.message)`;
  const url = await page.evaluate(set);
  log(
    url === remotePaths(dir).remote
      ? 'The project’s repository is the run’s remote.'
      : `Couldn’t set the project’s repository to the run’s remote: it reads ${url}.`,
  );
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
