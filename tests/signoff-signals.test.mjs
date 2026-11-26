import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDeps } from '../tools/signoff/deps.mjs';
import { EXIT, signoff } from '../tools/signoff.mjs';
import { COMMITS, GIT_DIR, gateLog, putLog, world } from './signoff-fake.mjs';

const ran = (w, re) => w.calls.filter((c) => re.test(c.argv.join(' ')));

/** An answer that raises signal while the command runs, as Ctrl-C or a kill would, and exits as it would on it. */
const raising =
  (/** @type {string} */ signal, code = 130) =>
  (_a, _o, w) => {
    w.raise(signal);
    return { code, out: '' };
  };

test('Ctrl-C during step 3 stops Biome, checks out nothing more, and removes the temporary worktree before exiting 130', async () => {
  const w = world({ answers: [[/--no-errors-on-unmatched/, raising('SIGINT')]] });
  putLog(w, gateLog(w.head));
  await signoff(['840'], w.d);
  assert.deepEqual(w.killed, ['SIGINT'], 'the signal is passed on to the running Biome');
  assert.equal(ran(w, /^git checkout/).length, 1, 'no commit is checked out after the signal');
  const [first] = w.exits;
  assert.equal(first.code, 130);
  const dir = w.temps[0];
  assert.ok(first.removed.includes(dir), 'the folder is removed before the exit');
  const removed = first.calls.filter((c) => c.argv.join(' ') === `git worktree remove --force ${dir}`);
  assert.equal(removed.length, 1, 'git forgets that worktree before the exit');
  assert.equal(removed[0].o.cwd, '/repo');
  assert.equal(ran(w, /^git worktree prune/).length, 0, 'the person’s other worktrees are left alone');
});

test('a signal while a quick git command runs in step 3 stops the next checkout too', async () => {
  // git diff ends well, as a quick command does when the signal reaches only this script; the checkout after it must not run.
  const quick = (_a, _o, w) => {
    w.raise('SIGTERM');
    return { code: 0, out: 'tools/signoff.mjs\0' };
  };
  const w = world({ answers: [[new RegExp(`^git diff -z --name-only .* ${COMMITS[1]} --$`), quick]] });
  putLog(w, gateLog(w.head));
  await signoff(['840'], w.d);
  assert.deepEqual(
    ran(w, /^git checkout/).map((c) => c.argv.at(-1)),
    [COMMITS[0]],
  );
  assert.equal(w.exits[0].code, 143);
  assert.ok(w.exits[0].removed.includes(w.temps[0]));
});

test('SIGTERM during step 4’s lints removes that step’s temporary worktree before exiting 143', async () => {
  const w = world({ answers: [[/^npm run -s lint:project$/, raising('SIGTERM', 143)]] });
  putLog(w, gateLog(w.head));
  await signoff(['840'], w.d);
  assert.deepEqual(w.killed, ['SIGTERM']);
  const [first] = w.exits;
  assert.equal(first.code, 143);
  assert.deepEqual(first.removed, w.temps.slice(0, 2), 'step 3’s folder and step 4’s, each removed');
});

test('a signal during --run-gate passes on to the running command, runs nothing more, and lets the slot go before exiting', async () => {
  const w = world({ answers: [[/^npm run check$/, raising('SIGHUP', 129)]] });
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.gate);
  assert.deepEqual(w.killed, ['SIGHUP'], 'the signal is passed on to npm run check');
  assert.equal(ran(w, /^npx playwright test/).length, 0, 'no browser run starts after it');
  assert.deepEqual(
    w.exits.map((e) => [e.code, e.released]),
    [[129, 1]],
    'exits 129, with the slot already let go',
  );
  assert.equal(w.files.has(`${GIT_DIR}/signoff/${w.head}.json`), false, 'no log for a stopped run');
});

test('a sign-off no signal stops leaves no signal handler behind and doesn’t exit itself', async () => {
  const w = world();
  assert.equal(await signoff(['840', '--run-gate'], w.d), EXIT.pass, w.lines.join('\n'));
  assert.equal(w.handlers.size, 0);
  assert.deepEqual(w.exits, []);
  assert.ok(w.handled >= 3, 'steps 3, 4 and the gate each watched for signals');
});

test('the real deps listen for SIGINT, SIGTERM and SIGHUP while asked, and stop listening after', () => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const before = signals.map((s) => process.listenerCount(s));
  const off = defaultDeps().onSignal(() => {});
  assert.deepEqual(
    signals.map((s) => process.listenerCount(s)),
    before.map((n) => n + 1),
  );
  off();
  assert.deepEqual(
    signals.map((s) => process.listenerCount(s)),
    before,
  );
});

test('a step whose temporary worktree can’t be made leaves no signal handler behind', async () => {
  const w = world({ answers: [[/^git worktree add /, () => ({ code: 128, out: 'fatal: could not create work tree dir' })]] });
  assert.notEqual(await signoff(['840'], w.d), EXIT.pass);
  assert.equal(w.handlers.size, 0, 'a later Ctrl-C still stops the script');
});
