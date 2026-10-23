import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';
import { fakeRepo } from './fake-repo.mjs';

const ROOT = '/work/proj';

/** A ledger over a repository in memory, with one turn of @dev's running in it, its folder's snapshot taken. */
export async function ledgerIn(repo) {
  const store = new Store(null);
  let t = 0;
  const ledger = new Ledger({ store, io: repo.io, git: repo.git, home: '/home/me', now: () => (t += 100) });
  store.emit('thread', { id: 'th_1', kind: 'thread', projectId: 'p1', members: [] });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder: ROOT, projectFolder: ROOT });
  await ledger.idle();
  let n = 0;
  /** A Bash call as Claude Code reports it: `does` changes the repository while it runs. */
  const run = async (command, does = () => {}, { output = '', result = {} } = {}) => {
    const id = `tu_${++n}`;
    ledger.toolUse(turn, { id, name: 'Bash', input: { command } });
    does();
    ledger.toolResult(turn, { id, text: output, result: { stdout: output, stderr: '', interrupted: false, ...result } });
    await ledger.idle();
  };
  const end = async () => {
    await ledger.endTurn(turn, { status: 'done' });
    await ledger.idle();
  };
  const of = (kind) => (store.state.work?.th_1 ?? []).filter((e) => e.kind === kind);
  return { store, ledger, turn, run, end, of };
}

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

test('a command outside git records nothing from git', async () => {
  const repo = fakeRepo('/elsewhere', {});
  const { run, end, of } = await ledgerIn(repo);
  await run('make');
  await end();
  assert.deepEqual([of('commit').length, of('branch').length], [0, 0]);
});
