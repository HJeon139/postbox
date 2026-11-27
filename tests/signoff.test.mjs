import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROGRESS_MS } from '../tools/signoff/wait.mjs';
import { majorsIn } from '../tools/signoff/workflows.mjs';
import { EXIT, signoff } from '../tools/signoff.mjs';
import { BASE_SHA, COMMITS, NO_CODEQL, NODE22, RED, world } from './signoff-fake.mjs';

const line = (w, re) => w.lines.find((l) => re.test(l));
const ran = (w, re) => w.calls.filter((c) => re.test(c.argv.join(' ')));

test('a head that passes every step exits 0, and its summary line names the head, the load and the counts', async () => {
  const w = world();
  assert.equal(await signoff(['840'], w.d), EXIT.pass);
  assert.equal(w.lines.at(-1), 'signoff #840 head=82ffee08 load=3.5/18 passed=5 failed=0 -> PASS');
  for (const n of [1, 2, 3, 4, 5]) assert.ok(line(w, new RegExp(`^✔ ${n}\\. `)), `step ${n} passed:\n${w.lines.join('\n')}`);
  assert.ok(line(w, /found v22\.11\.0/), 'step 2 found CI’s Node 22');
  assert.equal(ran(w, /biome check --error-on-warnings --no-errors-on-unmatched/).length, COMMITS.length, 'Biome ran once per commit');
});

test('a head that isn’t pushed fails at step 1', async () => {
  const w = world({ prHead: '9'.repeat(40) });
  assert.equal(await signoff(['840'], w.d), EXIT.head);
  assert.match(line(w, /^✖ 1\./), /local HEAD 82ffee08 isn’t #840’s head on GitHub, 99999999: push it/);
  assert.match(w.lines.at(-1), /failed=1 .*-> FAIL at step 1$/);
});

test('a missing Node that CI runs fails at step 2, saying how to install it', async () => {
  const w = world();
  w.files.delete(NODE22);
  assert.equal(await signoff(['840'], w.d), EXIT.toolchain);
  assert.match(line(w, /^✖ 2\./), /Node 22 isn’t installed: CI runs it \(\.github\/workflows\/check\.yml\)\. Install it \(nvm install 22/);
});

test('a Node that answers with another major doesn’t count as CI’s', async () => {
  const w = world({ answers: [[/node@22\/bin\/node --version$/, { code: 0, out: 'v24.1.0\n' }]] });
  assert.equal(await signoff(['840'], w.d), EXIT.toolchain);
});

test('the Node majors come from the workflows, a matrix list included', () => {
  assert.deepEqual(majorsIn('      - uses: actions/setup-node\n        with:\n          node-version: 22\n'), [22]);
  const matrix = `strategy:\n  matrix:\n    node: [22, 24]\nsteps:\n  - with:\n      node-version: \${{ matrix.node }}\n`;
  assert.deepEqual(majorsIn(matrix), [22, 24]);
  assert.deepEqual(majorsIn("node-version: '20.x'"), [20]);
});

test('a matrix key given as a block list, or in matrix.include entries, names its Node majors', () => {
  const uses = `steps:\n  - with:\n      node-version: \${{ matrix.node }}\n`;
  const block = `strategy:\n  matrix:\n    node:\n      - 22\n      - '24' # the next LTS\n    os: [ubuntu]\n${uses}`;
  assert.deepEqual(majorsIn(block), [22, 24]);
  const include = `strategy:\n  matrix:\n    include:\n      - node: 22\n        os: ubuntu\n      - os: macos\n        node: "24.x"\n${uses}`;
  assert.deepEqual(majorsIn(include), [22, 24]);
});

test('a node-version whose matrix key lists no major throws, naming the key, rather than requiring nothing', () => {
  const text = `strategy:\n  matrix:\n    version: [22]\nsteps:\n  - with:\n      node-version: \${{ matrix.node }}\n`;
  assert.throws(() => majorsIn(text), /node-version: \$\{\{ matrix\.node \}\} names no Node major: matrix\.node lists none this script can read/);
  assert.throws(() => majorsIn('node-version: lts/*\n'), /node-version: lts\/\* names lts\/\*, which isn’t a Node major/);
});

test('a workflow whose node-version names no major fails step 2, naming the workflow and the key', async () => {
  const w = world();
  w.files.set('/repo/.github/workflows/nightly.yml', `jobs:\n  t:\n    steps:\n      - with:\n          node-version: \${{ matrix.nodes }}\n`);
  assert.equal(await signoff(['840'], w.d), EXIT.toolchain);
  assert.match(
    line(w, /^✖ 2\./),
    /\.github\/workflows\/nightly\.yml: node-version: \$\{\{ matrix\.nodes \}\} names no Node major: job t has no strategy\.matrix block/,
  );
});

test('a red commit fails step 3, naming it, even when the head’s own files pass', async () => {
  const at = { now: '' };
  const w = world({
    answers: [
      [
        /^git checkout --quiet --detach /,
        (argv) => {
          at.now = argv.at(-1);
          return { code: 0, out: '' };
        },
      ],
      [
        /biome check .*--no-errors-on-unmatched/,
        () => (at.now === COMMITS[0] ? { code: 1, out: 'tools/signoff.mjs:3:1 lint/style/useConst' } : { code: 0, out: '' }),
      ],
    ],
  });
  assert.equal(await signoff(['840'], w.d), EXIT.commits);
  assert.match(line(w, /^✖ 3\./), /Biome fails at 1 of 2 commits: cccccccc \(tools\/signoff\.mjs:3:1 lint\/style\/useConst\)/);
  assert.ok(line(w, /^✔ 4\./), 'the merged tree, at the head, still passes');
});

test('Biome at each commit runs in a temporary worktree at that commit, never in the person’s tree', async () => {
  const w = world();
  await signoff(['840'], w.d);
  const biome = ran(w, /--no-errors-on-unmatched/);
  assert.ok(biome.every((c) => c.o.cwd.startsWith('/tmp/pb-signoff-')));
  assert.deepEqual(
    ran(w, /^git checkout/).map((c) => c.argv.at(-1)),
    COMMITS,
  );
  assert.equal(ran(w, /^git worktree add/).length, ran(w, /^git worktree remove/).length, 'each worktree is removed');
  assert.equal(w.temps.length, 2, 'one temporary folder for step 3, one for step 4');
  assert.deepEqual(w.removed, w.temps, 'each temporary folder is removed');
  // git worktree add writes only into the new folder; every git call that changes a checkout runs in that folder.
  const changesTree = ran(w, /^git (checkout|switch|restore|reset|merge |rebase|cherry-pick|revert|am|apply|stash|clean|pull)\b/);
  assert.ok(changesTree.length, 'the steps check out commits');
  for (const c of changesTree) assert.match(c.o.cwd, /^\/tmp\/pb-signoff-/, `${c.argv.join(' ')} ran in ${c.o.cwd}`);
  // The project lints run Biome from node_modules, which a new worktree lacks.
  assert.deepEqual(w.links[0], ['/repo/node_modules', `${biome[0].o.cwd}/node_modules`]);
});

test('step 3 reads each commit’s files NUL-separated and passes them after --, so no name is split or read as an option', async () => {
  const names = [' lead.mjs', 'tools/a b.mjs', '-rf.mjs', 'tools/naïve.mjs'];
  // As git answers: -z gives the names as they are, else one a line with a non-ASCII name quoted.
  const diff = (argv) => ({ code: 0, out: argv.includes('-z') ? `${names.join('\0')}\0` : ' lead.mjs\ntools/a b.mjs\n-rf.mjs\n"tools/na\\303\\257ve.mjs"\n' });
  const w = world({ answers: [[/^git diff /, diff]] });
  assert.equal(await signoff(['840'], w.d), EXIT.pass, w.lines.join('\n'));
  for (const c of ran(w, /^git diff /)) assert.equal(c.argv.at(-1), '--', `${c.argv.join(' ')} ends its revisions with --`);
  const biome = ran(w, /--no-errors-on-unmatched/);
  assert.equal(biome.length, COMMITS.length);
  for (const c of biome) assert.deepEqual(c.argv.slice(-5), ['--', ...names]);
});

test('a merge conflict with the freshly fetched base fails step 4, naming the files', async () => {
  const conflict = { code: 1, out: `${'e'.repeat(40)}\nserver/runtime.mjs\n\nAuto-merging server/runtime.mjs\nCONFLICT (content)\n` };
  const w = world({ answers: [[/^git merge-tree /, conflict]] });
  assert.equal(await signoff(['840'], w.d), EXIT.merged);
  assert.match(line(w, /^✖ 4\./), /conflicts with bbbbbbbb in server\/runtime\.mjs/);
  assert.ok(ran(w, /^git fetch .* refs\/heads\/main$/).length, 'the base was fetched first');
  assert.equal(ran(w, /^npm run -s lint:project$/).length, 0, 'nothing ran on a merge that didn’t happen');
});

test('a merged tree that fails the project lints fails step 4', async () => {
  const w = world({ answers: [[/^npm run -s lint:project$/, { code: 1, out: 'lint-tokens: no problems.\nlint-caps: 1 problem(s)\n' }]] });
  assert.equal(await signoff(['840'], w.d), EXIT.merged);
  assert.match(line(w, /^✖ 4\./), /fails the project lints \(lint-caps: 1 problem\(s\)\)/);
  assert.equal(ran(w, /^npm run -s lint:project$/)[0].o.env.BASE_REF, 'main');
  // The lints that compare with a base take the freshly fetched one, not a remote-tracking ref that can be stale.
  assert.equal(ran(w, /^npm run -s lint:project$/)[0].o.env.BASE_SHA, BASE_SHA);
});

test('a merged tree that fails Biome fails step 4', async () => {
  const w = world({ answers: [[/biome check --error-on-warnings \.$/, { code: 1, out: 'Found 1 error.' }]] });
  assert.equal(await signoff(['840'], w.d), EXIT.merged);
});

test('a head where CodeQL never ran fails step 5, through A2’s check', async () => {
  const w = world({ runs: NO_CODEQL });
  assert.equal(await signoff(['783'], w.d), EXIT.checks);
  assert.ok(w.lines.includes('missing: CodeQL (code scanning)'));
  assert.match(line(w, /^✖ 5\./), /^✖ 5\. GitHub’s checks: fail, as the line above says$/);
});

test('a red required check fails step 5', async () => {
  const w = world({ runs: RED });
  assert.equal(await signoff(['808'], w.d), EXIT.checks);
  assert.ok(w.lines.includes('fail: Lint, types, project rules and tests (required)'));
});

test('several failures exit with the first one’s step, and every step still reports', async () => {
  const w = world({ runs: RED, prHead: '9'.repeat(40) });
  assert.equal(await signoff(['808'], w.d), EXIT.head);
  assert.match(w.lines.at(-1), /passed=3 failed=2 -> FAIL at step 1$/);
});

test('a range with no commits fails step 3: a wrong base checked nothing', async () => {
  const w = world({ answers: [[/^git rev-list --reverse /, { code: 0, out: '' }]] });
  assert.equal(await signoff(['840'], w.d), EXIT.commits);
  assert.match(line(w, /^✖ 3\./), /no commits between the merge base aaaaaaaa and HEAD/);
});

test('workflows with no node-version fail step 2, rather than requiring nothing', async () => {
  const w = world();
  w.files.set('/repo/.github/workflows/check.yml', 'jobs: {}\n');
  assert.equal(await signoff(['840'], w.d), EXIT.toolchain);
  assert.match(line(w, /^✖ 2\./), /found no node-version/);
});

test('a pull request gh can’t read fails step 1, and the steps that need its base say why they can’t run', async () => {
  const w = world();
  w.d.gh = () => {
    throw new Error('HTTP 404: Not Found\nmore');
  };
  assert.equal(await signoff(['840'], w.d), EXIT.head);
  assert.match(line(w, /^✖ 1\./), /HTTP 404: Not Found$/);
  assert.match(line(w, /^✖ 3\./), /no base branch/);
  assert.match(line(w, /^✖ 4\./), /no fetched base/);
});

test('a long command prints a line at least once a minute while it runs, and stops when it ends', async () => {
  const slow = (_a, _o, w) => {
    w.tick(PROGRESS_MS);
    w.tick(PROGRESS_MS);
    return { code: 0, out: '' };
  };
  const w = world({ answers: [[/^npm run -s lint:project$/, slow]] });
  assert.equal(await signoff(['840'], w.d), EXIT.pass, w.lines.join('\n'));
  assert.ok(w.every <= 60_000, 'a line at least every minute');
  const waits = w.lines.filter((l) => l.startsWith('… still waiting on npm run -s lint:project'));
  assert.deepEqual(waits, ['… still waiting on npm run -s lint:project, 50 s so far', '… still waiting on npm run -s lint:project, 100 s so far']);
  assert.equal(w.timers.size, 0, 'no timer outlives its command');
});

test('an empty --node is an error before anything runs, and so is a missing pull request number', async () => {
  for (const argv of [
    ['840', '--node'],
    ['840', '--node', ''],
    ['840', '--node', '--node', '/x'],
  ]) {
    const w = world();
    assert.equal(await signoff(argv, w.d), EXIT.usage, argv.join(' '));
    assert.match(w.lines[0], /^--node needs a value/);
    assert.equal(w.calls.length, 0, 'nothing ran');
  }
  for (const argv of [[], ['840', '--run-gate']]) assert.equal(await signoff(argv, world().d), EXIT.usage, argv.join(' '));
});
