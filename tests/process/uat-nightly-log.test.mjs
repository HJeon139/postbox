// The idleroom scenario’s nightly check (tests/uat/e2e/fixtures/nightly/nightly.mjs, #1746) and what the UAT reads of
// it (tools/uat/nightly-log.mjs): the real script in a throwaway repository, queued, asked while it runs, and asked
// again once it’s due. It runs git and node, so it’s under tests/process/ (npm run test:process). The script takes 4
// minutes by the clock; the test moves the due time it recorded into the past, as those minutes passing would.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nightlyLog, nightlyWork } from '../../tools/uat/nightly-log.mjs';
import { TRIGGERS } from '../../tools/uat/triggers.mjs';

const FIXTURE = fileURLToPath(new URL('../uat/e2e/fixtures/nightly', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'pb-test-nightly-'));
after(() => rmSync(home, { recursive: true, force: true }));
writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = Agent\n\temail = agent@example.com\n[init]\n\tdefaultBranch = main\n');
// Git as a fresh install has it, and node’s test runner as a shell has it: this file’s own runner isn’t the script’s.
const { NODE_TEST_CONTEXT: _runner, ...outside } = process.env;
const env = { ...outside, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };

function run(/** @type {string} */ cwd, /** @type {string} */ cmd, /** @type {string[]} */ args) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw r.error;
  return `${r.stdout}${r.stderr}`.trim();
}
const nightly = (/** @type {string} */ cwd, /** @type {string} */ command) => run(cwd, process.execPath, ['nightly.mjs', command]);

/** A workspace as the runner seeds it: a repository with the fixture’s files, and a helper with one passing test. */
function workspace() {
  const dir = mkdtempSync(join(home, 'workspace-'));
  run(dir, 'git', ['init', '-q']);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'slug.mjs'), "export const slug = (title) => title.toLowerCase().replace(/\\s+/g, '-');\n");
  writeFileSync(
    join(dir, 'slug.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { slug } from './slug.mjs';\ntest('spaces', () => assert.equal(slug('A b'), 'a-b'));\n",
  );
  return dir;
}

test('the nightly check refuses work that isn’t committed, and records nothing', () => {
  const dir = workspace();
  assert.match(nightly(dir, 'status'), /^NIGHTLY NOT QUEUED/);
  assert.match(nightly(dir, 'queue'), /^NIGHTLY REFUSED: there is no commit to check/);
  assert.deepEqual(nightlyLog(dir), []);
  assert.deepEqual(nightlyWork({ workspace: dir, events: [] }), { asked: null, queued: null, passed: null });
  assert.deepEqual(TRIGGERS['timed-step-queued'].run({ workspace: dir }), []);
});

test('a queued check is due 4 minutes on, says it runs until then, and passes on its commit once due; the UAT reads each from its record', () => {
  const dir = workspace();
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-q', '-m', 'slug']);
  const before = Date.now();
  const said = nightly(dir, 'queue');
  assert.match(said, /^NIGHTLY QUEUED commit=[0-9a-f]{7,} due=\d{4}-\d\d-\d\dT[\d:.]+Z\n.*Nothing tells you when it has finished/);
  const queued = nightlyWork({ workspace: dir }).queued;
  assert.ok(queued && queued.at >= before && queued.at <= Date.now(), 'queued when the script ran');
  assert.equal(queued.due, queued.at + 240_000);
  assert.equal(Date.parse(/due=(\S+)/.exec(said)?.[1] ?? ''), queued.due, 'the time it printed is the time it recorded');
  // Whatever the computer’s load made of the seconds since: still running, with most of its 4 minutes left.
  const left = Number(/^NIGHTLY RUNNING commit=[0-9a-f]+ left=(\d+)s$/.exec(nightly(dir, 'status'))?.[1]);
  assert.ok(left > 200 && left <= 240, `left=${left}`);
  assert.equal(nightlyWork({ workspace: dir }).passed, null, 'asking while it runs is no pass');
  const [hit] = TRIGGERS['timed-step-queued'].run({ workspace: dir });
  assert.equal(hit.at, queued.at);
  assert.match(hit.evidence, /^Queued at [\d:]+ UTC, due at [\d:]+ UTC\.$/);

  // Four minutes on.
  const record = join(dir, '.git', 'nightly.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), due: Date.now() - 1 }));
  assert.match(nightly(dir, 'status'), /^NIGHTLY PASSED commit=[0-9a-f]+ tests=1$/);
  const work = nightlyWork({ workspace: dir });
  assert.ok(work.passed && work.passed.at >= queued.at);
  // A recheck: the temp folder the run worked in is gone, and its kept copy has the record.
  assert.deepEqual(nightlyWork({ workspace: join(dir, 'gone'), workspaceKept: dir }), work);
  assert.deepEqual(
    nightlyLog(dir).map((x) => x.did),
    ['queued', 'passed'],
  );
  assert.equal(run(dir, 'git', ['status', '--porcelain']), '', 'the check leaves the working tree clean');
});

test('failing tests fail the check, which is no pass', () => {
  const dir = workspace();
  writeFileSync(join(dir, 'slug.mjs'), 'export const slug = (title) => title;\n');
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-q', '-m', 'slug']);
  nightly(dir, 'queue');
  const record = join(dir, '.git', 'nightly.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), due: Date.now() - 1 }));
  assert.match(nightly(dir, 'status'), /^NIGHTLY FAILED commit=[0-9a-f]+\n/);
  assert.equal(nightlyWork({ workspace: dir }).passed, null);
  assert.deepEqual(
    nightlyLog(dir).map((x) => x.did),
    ['queued', 'failed'],
  );
});
