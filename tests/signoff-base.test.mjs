// Steps 3 and 4 of tools/signoff.mjs use a base freshly fetched from the pull request’s base repository (#845): a
// remote-tracking ref goes stale in a single-branch clone or one with a narrowed refspec, and a fork’s origin is the
// fork, so neither is read.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, signoff } from '../tools/signoff.mjs';
import { BASE_REPO, BASE_SHA, gateLog, MERGE_BASE, putLog, STALE_SHA, world } from './signoff-fake.mjs';

/** A world whose head has a passing gate log. @param {Parameters<typeof world>[0]} [o] */
const signed = (o) => {
  const w = world(o);
  putLog(w, gateLog(w.head));
  return w;
};
const ran = (w, re) => w.calls.filter((c) => re.test(c.argv.join(' ')));
/** Makes gh say the pull request is at url. @param {ReturnType<typeof world>} w @param {string} url */
const prAt = (w, url) => {
  const gh = w.d.gh;
  w.d.gh = (args) => (args[0] === 'pr' ? { ...gh(args), url } : gh(args));
};

test('step 3’s range and step 4’s merge use the base fetched from the pull request’s repository, not a remote ref', async () => {
  const w = signed();
  assert.equal(await signoff(['840'], w.d), EXIT.pass);
  assert.deepEqual(ran(w, /^git fetch /)[0].argv, ['git', 'fetch', '--quiet', '--no-tags', '--', BASE_REPO, 'refs/heads/main']);
  assert.deepEqual(ran(w, /^git merge-base /)[0].argv, ['git', 'merge-base', 'HEAD', BASE_SHA]);
  assert.equal(ran(w, /^git rev-list /)[0].argv.at(-1), `${MERGE_BASE}..HEAD`);
  assert.deepEqual(ran(w, /^git merge-tree /)[0].argv.slice(-2), ['HEAD', BASE_SHA]);
  assert.ok(ran(w, /^git commit-tree /)[0].argv.includes(BASE_SHA));
  assert.equal(ran(w, new RegExp(`refs/remotes|${STALE_SHA}`)).length, 0, 'nothing read the remote-tracking ref');
});

test('a fork’s clone fetches the base from the base repository the pull request names, whatever origin is', async () => {
  const upstream = 'https://github.com/upstream/postbox';
  const w = signed({ answers: [[new RegExp(`^git fetch --quiet --no-tags -- ${upstream} refs/heads/main$`), { code: 0, out: '' }]] });
  prAt(w, `${upstream}/pull/7`);
  await signoff(['7'], w.d);
  assert.deepEqual(
    ran(w, /^git fetch /).map((c) => c.argv[5]),
    [upstream],
  );
  assert.ok(
    w.lines.some((l) => l.startsWith('✔ 3.')),
    w.lines.join('\n'),
  );
});

test('a pull request URL that names no repository fails steps 3 and 4, fetching nothing', async () => {
  const w = signed();
  prAt(w, 'not a pull request');
  assert.equal(await signoff(['840'], w.d), EXIT.commits);
  assert.match(w.lines.find((l) => l.startsWith('✖ 3.')) ?? '', /couldn’t fetch main: #840’s URL, not a pull request, names no repository/);
  assert.match(w.lines.find((l) => l.startsWith('✖ 4.')) ?? '', /no fetched base to merge with/);
  assert.equal(ran(w, /^git fetch /).length, 0);
});

test('a fetch that fails fails step 3, rather than falling back to what the clone last fetched', async () => {
  const w = signed({ answers: [[/^git fetch /, { code: 128, out: 'fatal: could not read from remote repository' }]] });
  assert.equal(await signoff(['840'], w.d), EXIT.commits);
  assert.match(w.lines.find((l) => l.startsWith('✖ 3.')) ?? '', /couldn’t fetch main: .*could not read from remote repository/);
  assert.equal(ran(w, /^git rev-parse (refs\/remotes|--verify FETCH_HEAD)/).length, 0);
});
