// A check of the work ledger against real git (#156): the commits and branches a command made, seen by comparing its
// repository as it starts and as it ends. Each case runs real git commands in a fresh temp folder, between the ledger’s toolUse and
// toolResult, as Claude Code’s Bash tool would, and reads what the ledger recorded. Unit tests can’t start processes
// (tests/guard.mjs), and their repository in memory (tests/fake-repo.mjs) can’t show what git itself does with
// `git init`, `--amend`, `reset`, `rebase` and `pull`. The files a command changes are #240’s.
//
//   node tools/check-ledger-git.mjs
//
// No server or browser; it only needs git.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';
import { finish, record } from './harness.mjs';

const home = await mkdtemp(join(tmpdir(), 'pb-check-ledger-git-'));
// Git as a fresh install would be, whoever runs this: no hooks, signing or templates from the person’s own config.
await writeFile(
  join(home, 'gitconfig'),
  '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n',
);
process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const sh = (cwd, line) => execFileSync('/bin/sh', ['-c', line], { cwd, stdio: 'pipe' }).toString();

/** A ledger with a conversation per name, each with one turn at work in folder. */
function ledgerAt(folder, names = ['dev']) {
  const store = new Store(null);
  const ledger = new Ledger({ store, home });
  const turns = {};
  for (const name of names) {
    store.emit('thread', { id: `th_${name}`, kind: 'thread', projectId: 'p1', members: [] });
    turns[name] = { id: `turn_${name}`, threadId: `th_${name}`, startedAt: Date.now() };
    ledger.startTurn(turns[name], { se: { id: `se_${name}`, handle: name }, folder, projectFolder: folder });
  }
  let n = 0;
  const start = async (who, line) => {
    const id = `tu_${++n}`;
    ledger.toolUse(turns[who], { id, name: 'Bash', input: { command: line } });
    await ledger.idle();
    return id;
  };
  const finishCmd = async (who, id, vcsCwd = null) => {
    ledger.toolResult(turns[who], { id, text: '', vcsCwd, result: { stdout: '', stderr: '', interrupted: false } });
    await ledger.idle();
  };
  /** A command that runs on its own: started, run, ended. */
  const run = async (line, who = 'dev') => {
    const id = await start(who, line);
    sh(folder, line);
    await finishCmd(who, id);
  };
  const end = async () => {
    for (const t of Object.values(turns)) await ledger.endTurn(t, { status: 'done' });
    await ledger.idle();
  };
  const of = (kind, who = 'dev') => (store.state.work?.[`th_${who}`] ?? []).filter((e) => e.kind === kind);
  return { ledger, run, start, finishCmd, end, of };
}

async function scene(name, fn) {
  const dir = await mkdtemp(join(home, 'repo-'));
  try {
    await fn(dir);
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  }
}
const repo = (dir) => sh(dir, 'git init -q . && echo one > a.txt && git add a.txt && git commit -q -m Start');
const commits = (of) => of('commit').map((c) => `${c.message}${c.left ? ' (left)' : ''}`);

await scene('#156’s own case: `git init && add && commit`, then `add && commit`, in a folder that wasn’t a repository', async (dir) => {
  await writeFile(join(dir, 'README.md'), '# Converter\n');
  const { run, end, of } = ledgerAt(dir);
  await run('git init -q . && git add README.md && git commit -q -m First');
  await run('echo more >> README.md && git add README.md && git commit -q -m Second');
  await end();
  assert.deepEqual(commits(of), ['First', 'Second']);
});

await scene('a sed across three files and a quiet commit in one command: the commit, with its three files', async (dir) => {
  sh(dir, 'git init -q . && for f in a b c; do echo km_to_mi > $f.py; done && git add . && git commit -q -m Start');
  const { run, end, of } = ledgerAt(dir);
  await run('sed -i.bak s/km_to_mi/kilometres_to_miles/ a.py b.py c.py && rm *.bak && git commit -qam Rename');
  await end();
  assert.deepEqual(commits(of), ['Rename']);
  assert.deepEqual(
    of('commit')[0].files.map((f) => `${f.path} +${f.added} −${f.deleted}`),
    ['a.py +1 −1', 'b.py +1 −1', 'c.py +1 −1'],
  );
  assert.deepEqual(of('file'), [], 'the files a command changes are #240’s');
});

await scene('--amend: the amended commit is marked as left, and only the new one is added', async (dir) => {
  repo(dir);
  const { run, end, of } = ledgerAt(dir);
  await run('echo two > a.txt && git commit -qam Typo');
  await run('git commit -q --amend -m Fixed');
  await end();
  assert.deepEqual(commits(of), ['Typo (left)', 'Fixed']);
});

await scene('reset --soft HEAD~2 && commit: the two squashed commits left, one new', async (dir) => {
  repo(dir);
  const { run, end, of } = ledgerAt(dir);
  await run('echo 1 >> a.txt && git commit -qam A && echo 2 >> a.txt && git commit -qam B');
  await run('git reset -q --soft HEAD~2 && git commit -qm AB');
  await end();
  assert.deepEqual(commits(of), ['A (left)', 'B (left)', 'AB']);
});

await scene('reset --hard HEAD~1: the undone commit is marked as left', async (dir) => {
  repo(dir);
  const { run, end, of } = ledgerAt(dir);
  await run('echo 2 >> a.txt && git commit -qam Undone');
  await run('git reset -q --hard HEAD~1');
  await end();
  assert.deepEqual(commits(of), ['Undone (left)']);
});

await scene('rebase onto main: the rebased commit once, and nothing of main’s', async (dir) => {
  repo(dir);
  sh(dir, 'git switch -q -c feature && echo f > f.txt && git add f.txt && git commit -qm F1');
  sh(dir, 'git switch -q main && echo m > m.txt && git add m.txt && git commit -qm M1 && git switch -q feature');
  const { run, end, of } = ledgerAt(dir);
  await run('git rebase -q main');
  await end();
  assert.deepEqual(commits(of), ['F1']);
});

await scene('a pull’s commits aren’t the agent’s; a commit it pushes is', async (dir) => {
  const remote = join(dir, 'remote.git');
  const mine = join(dir, 'mine');
  const theirs = join(dir, 'theirs');
  sh(
    dir,
    `git init -q --bare remote.git && git clone -q remote.git theirs && cd theirs && echo one > a.txt && git add a.txt && git commit -qm Start && git push -q origin main`,
  );
  sh(dir, `git clone -q ${remote} mine`);
  sh(theirs, 'echo b > b.txt && git add b.txt && git commit -qm Theirs && git push -q origin main');
  const { run, end, of } = ledgerAt(mine);
  await run('git pull -q --ff-only');
  await run('echo two > a.txt && git commit -qam Mine && git push -q');
  await end();
  assert.deepEqual(commits(of), ['Mine']);
});

await scene('commands overlapping from three conversations: the commit is in each one running when it was made, not in one started after', async (dir) => {
  repo(dir);
  const { start, finishCmd, end, of } = ledgerAt(dir, ['alice', 'bob', 'carol']);
  const test = await start('bob', 'npm test');
  const mine = await start('alice', 'git commit -qam ByAlice');
  sh(dir, 'echo two > a.txt && git commit -qam ByAlice');
  const lint = await start('carol', 'npm run lint');
  await finishCmd('alice', mine);
  await finishCmd('bob', test);
  await finishCmd('carol', lint);
  await end();
  assert.deepEqual(
    commits((k) => of(k, 'alice')),
    ['ByAlice'],
  );
  assert.deepEqual(
    commits((k) => of(k, 'bob')),
    ['ByAlice'],
    'Bob’s command was running',
  );
  assert.deepEqual(
    commits((k) => of(k, 'carol')),
    [],
    'Carol’s started after it',
  );
  assert.equal(of('commit', 'bob')[0].handle, 'bob');
});

await scene('a folder Claude Code says it ran git in, left over from another repository, doesn’t move the comparison', async (dir) => {
  const here = join(dir, 'here');
  const there = join(dir, 'there');
  sh(dir, 'mkdir here there && cd here && git init -q . && echo a > a.txt && git add a.txt && git commit -qm Start');
  sh(there, 'git init -q . && echo b > b.txt && git add b.txt && git commit -qm There');
  const { start, finishCmd, end, of } = ledgerAt(here);
  const id = await start('dev', 'git commit -qam Here');
  sh(here, 'echo two > a.txt && git commit -qam Here');
  sh(there, 'echo two > b.txt && git commit -qam AlsoThere');
  await finishCmd('dev', id, there);
  await end();
  // git names the repository by its real path (/private/var on macOS), so only its last folder is compared.
  assert.deepEqual(
    of('commit').map((c) => [c.message, c.cwd.split('/').at(-1)]),
    [['Here', 'here']],
  );
});

await rm(home, { recursive: true, force: true });
finish();
