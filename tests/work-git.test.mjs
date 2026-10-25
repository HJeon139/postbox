import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGit } from '../server/ledger-git.mjs';
import { fakeRepo, ledgerIn } from './fake-repo.mjs';

const ROOT = '/work/proj';

test('a commit made inside a compound command is recorded, with its files, though Claude Code didn’t report it (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  await run(`python3 -c "open('a.txt','w').write('two\\n')" && git add -A && git commit -q -m "Change a"`, () => {
    repo.write('a.txt', 'two\n');
    repo.commit('Change a');
  });
  await end();
  const commits = of('commit');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].message, 'Change a', 'its message, from git');
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    commits[0].files.map((f) => `${f.path} +${f.added} −${f.deleted}`),
    ['a.txt +1 −1'],
  );
  assert.equal(commits[0].commandId, of('command')[0].id, 'under the command that made it');
});

test('a commit Claude Code reports (gitOperation) is recorded once, and a branch a script made is seen (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  // The snapshot to compare with is the turn's, so a change made before the call is the command's too.
  repo.write('a.txt', 'one\ntwo\n');
  const sha = repo.commit('Second');
  await run('git commit -am "Second"', () => {}, {
    output: `[main ${sha.slice(0, 7)}] Second`,
    result: { gitOperation: { commit: { sha: sha.slice(0, 7), branch: 'main' } } },
  });
  await run('./scripts/start-topic.sh', () => repo.branch('topic'));
  await run('./scripts/commit-twice.sh', () => {
    repo.write('a.txt', 'three\n');
    repo.commit('Third');
    repo.write('b.txt', 'b\n');
    repo.commit('Fourth');
  });
  await end();
  assert.deepEqual(
    of('commit').map((c) => c.message),
    ['Second', 'Third', 'Fourth'],
    'each commit once, oldest first',
  );
  assert.deepEqual(
    of('branch').map((b) => b.name),
    ['topic'],
  );
  assert.equal(of('commit')[2].branch, 'topic');
  assert.ok(
    repo.git.calls.every((c) => /^git (rev-parse|ls-files|show|status|log|branch -r|check-ignore|symbolic-ref|for-each-ref|rev-list|diff)\b/.test(c)),
    'nothing but reads',
  );
});

test('a reported commit whose sha isn’t hex never reaches git, where --output= would write a file (#351)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  for (const sha of ['--output=/tmp/pb-written', '-p', 'HEAD~1', ''])
    await run('git commit -am "Second"', () => {}, { output: '', result: { gitOperation: { commit: { sha, branch: 'main' } } } });
  await end();
  assert.deepEqual(of('commit'), []);
  assert.ok(!repo.git.calls.some((c) => / (show|branch -r --contains) (-|HEAD~)|--output=/.test(c)), repo.git.calls.join('\n'));
});

test('every git read sets off the commands a repository’s config can name, its content filters among them (#351)', async () => {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, env: opts.env });
    cb(null, args[0] === 'config' ? 'filter.lfs.clean\0filter.lfs.smudge\0filter.a.b.process\0' : '', '');
  };
  await runGit(ROOT, ['status', '--porcelain=v1', '-z'], { exec });
  await runGit(ROOT, ['show', '--numstat', 'abc1234'], { exec });
  const config = (env) =>
    Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  const [, status, , show] = calls;
  for (const c of [status, show])
    assert.deepEqual(config(c.env), {
      'core.fsmonitor': 'false',
      'core.hooksPath': '/dev/null',
      'diff.external': '',
      'log.showSignature': 'false',
      'filter.lfs.clean': '',
      'filter.lfs.smudge': '',
      'filter.lfs.process': '',
      'filter.lfs.required': 'false',
      'filter.a.b.clean': '',
      'filter.a.b.smudge': '',
      'filter.a.b.process': '',
      'filter.a.b.required': 'false',
    });
  assert.deepEqual(status.args, ['status', '--porcelain=v1', '-z']);
  assert.deepEqual(show.args, ['show', '--no-ext-diff', '--no-textconv', '--numstat', 'abc1234']);
  // The filters are asked for with the commands already off.
  assert.equal(config(calls[0].env)['core.fsmonitor'], 'false');
});

test('a command outside git records nothing from git', async () => {
  const repo = fakeRepo('/elsewhere', {});
  const { run, end, of } = await ledgerIn(repo, ROOT);
  await run('make');
  await end();
  assert.deepEqual([of('commit').length, of('branch').length], [0, 0]);
  assert.ok(!repo.git.calls.some((c) => / (for-each-ref|status|log) /.test(c)), 'no snapshot was asked for a folder outside git');
});

test('a pull’s commits aren’t the agent’s, but commits it pushed are (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  const theirs = repo.fetched('Someone else’s change', { 'b.txt': 'b\n' });
  await run('git pull --ff-only', () => repo.fastForward(theirs));
  await run('git commit -qam "Mine" && git push', () => {
    repo.write('a.txt', 'two\n');
    const mine = repo.commit('Mine');
    repo.pushed(mine);
  });
  await end();
  assert.deepEqual(
    of('commit').map((c) => c.message),
    ['Mine'],
  );
});

test('a command the backend refused records nothing from git (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { ledger, turn, end, of } = await ledgerIn(repo);
  ledger.toolUse(turn, { id: 'no', name: 'Bash', input: { command: 'make clean' } });
  ledger.denied(turn, 'no');
  repo.write('a.txt', 'changed by the person\n');
  repo.commit('By the person');
  ledger.toolResult(turn, { id: 'no', isError: true, text: 'Permission denied' });
  await end();
  assert.deepEqual(of('commit'), []);
});

test('a repository a command made, and its first commits, are recorded (#156’s own case)', async () => {
  const repo = fakeRepo(ROOT, { 'README.md': '# Converter\n' });
  repo.unborn();
  const { run, end, of } = await ledgerIn(repo);
  await run('git init -q . && git add README.md && git commit -q -m "First"', () => {
    repo.init();
    repo.commit('First');
  });
  await run('git add README.md && git commit -q -m "Second"', () => {
    repo.write('README.md', '# Converter\n\nTwo.\n');
    repo.commit('Second');
  });
  await end();
  assert.deepEqual(
    of('commit').map((c) => c.message),
    ['First', 'Second'],
  );
});

test('an amended or reset commit is marked as no longer on the branch, and only the new one is recorded (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  const base = repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  await run('git commit -qam "Typo"', () => {
    repo.write('a.txt', 'two\n');
    repo.commit('Typo');
  });
  await run('git commit -q --amend -am "Fixed"', () => {
    repo.reset(base);
    repo.commit('Fixed');
  });
  await end();
  assert.deepEqual(
    of('commit').map((c) => [c.message, Boolean(c.left)]),
    [
      ['Typo', true],
      ['Fixed', false],
    ],
  );
});

test('a commit made while commands overlapped in one folder is listed in each conversation, but never under a command that started after it (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { ledger, store, turn, end, of } = await ledgerIn(repo);
  store.emit('thread', { id: 'th_2', kind: 'thread', projectId: 'p1', members: [] });
  store.emit('thread', { id: 'th_3', kind: 'thread', projectId: 'p1', members: [] });
  const bob = { id: 'turn_b', threadId: 'th_2', startedAt: 0 };
  const carol = { id: 'turn_c', threadId: 'th_3', startedAt: 0 };
  ledger.startTurn(bob, { se: { id: 'se_b', handle: 'bob' }, folder: ROOT, projectFolder: ROOT });
  ledger.startTurn(carol, { se: { id: 'se_c', handle: 'carol' }, folder: ROOT, projectFolder: ROOT });
  ledger.toolUse(bob, { id: 'test', name: 'Bash', input: { command: 'npm test' } });
  ledger.toolUse(turn, { id: 'mine', name: 'Bash', input: { command: 'git commit -qam ByDev' } });
  await ledger.idle();
  repo.write('a.txt', 'two\n');
  repo.commit('ByDev');
  // Carol’s command starts after the commit, so its own start already has it.
  ledger.toolUse(carol, { id: 'lint', name: 'Bash', input: { command: 'npm run lint' } });
  await ledger.idle();
  for (const [t, id] of [
    [turn, 'mine'],
    [bob, 'test'],
    [carol, 'lint'],
  ]) {
    ledger.toolResult(t, { id, text: '', result: { stdout: '', stderr: '' } });
    await ledger.idle();
  }
  for (const t of [bob, carol]) await ledger.endTurn(t, { status: 'done' });
  await end();
  const in_ = (th) => (store.state.work[th] ?? []).filter((e) => e.kind === 'commit').map((c) => [c.message, c.handle, Boolean(c.overlap)]);
  assert.deepEqual(
    of('commit').map((c) => [c.message, c.handle, Boolean(c.overlap)]),
    [['ByDev', 'dev', true]],
  );
  assert.deepEqual(in_('th_2'), [['ByDev', 'bob', true]], 'once in Bob’s, under his own command');
  assert.deepEqual(in_('th_3'), [], 'not Carol’s: her start already had it');
});

test('a folder Claude Code says it ran git in, left over from another repository, doesn’t move the comparison (#156)', async () => {
  const repo = fakeRepo(ROOT, { 'a.txt': 'one\n' });
  repo.commit('Start');
  const { run, end, of } = await ledgerIn(repo);
  await run(
    'git commit -qam Here',
    () => {
      repo.write('a.txt', 'two\n');
      repo.commit('Here');
    },
    { vcsCwd: '/work/other' },
  );
  await end();
  assert.deepEqual(
    of('commit').map((c) => [c.message, c.cwd]),
    [['Here', ROOT]],
  );
});
