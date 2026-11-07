import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EXIT, evaluate, latestByName, report, requiredOf, signoffChecks } from '../tools/signoff-checks.mjs';

// Recorded from GitHub's API on 6 Nov 2026 (tests/fixtures/signoff): main's rules, and the check runs of four heads.
const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/signoff/${name}.json`, import.meta.url), 'utf8'));
const RULES = load('rules-main');
const MERGED = load('check-runs-840');
const NO_CODEQL = load('check-runs-783-before-rebase');
const RED = load('check-runs-808-red');
const REQUIRED = requiredOf(RULES);

/** A recorded head’s runs, each changed by `edit` where it returns one. */
const edited = (fixture, edit) => fixture.check_runs.map((run) => edit(run) ?? run);

test('main requires four status checks and CodeQL, read from its rules, not a list of our own', () => {
  assert.deepEqual(REQUIRED.tools, ['CodeQL']);
  assert.equal(REQUIRED.contexts.length, 4);
  assert.ok(REQUIRED.contexts.includes('Lint, types, project rules and tests'));
});

test('a head with every required check and CodeQL passed passes, and its summary line says so', () => {
  const v = evaluate(REQUIRED, MERGED.check_runs);
  assert.equal(v.exit, EXIT.pass);
  assert.deepEqual(report(840, MERGED.head, v), ['signoff-checks #840 head=82ffee08 required=5/5 codeql=pass red=0 -> PASS']);
});

test('a head where CodeQL never ran fails, naming it, though gh pr checks exits 0 on it', () => {
  const v = evaluate(REQUIRED, NO_CODEQL.check_runs);
  assert.equal(v.exit, EXIT.fail);
  const lines = report(783, NO_CODEQL.head, v);
  assert.deepEqual(lines, ['missing: CodeQL (code scanning)', 'signoff-checks #783 head=35a4d2fd required=4/5 codeql=missing red=0 -> FAIL']);
});

test('a head with a red required check fails, naming each red check', () => {
  const v = evaluate(REQUIRED, RED.check_runs);
  assert.equal(v.exit, EXIT.fail);
  const lines = report(808, RED.head, v);
  assert.ok(lines.includes('fail: Lint, types, project rules and tests (required)'), lines.join('\n'));
  assert.ok(lines.includes('fail: Demo in Chrome, with accessibility checks (required)'), lines.join('\n'));
  assert.match(lines.at(-1), /-> FAIL$/);
});

test('a red check that isn’t required still fails the head', () => {
  const runs = edited(MERGED, (r) => (r.name === 'Prompt surface diff and SkillSpector' ? { ...r, conclusion: 'failure' } : null));
  const v = evaluate(REQUIRED, runs);
  assert.equal(v.exit, EXIT.fail);
  assert.deepEqual(v.red, ['Prompt surface diff and SkillSpector']);
});

test('CodeQL must succeed: skipped, which passes a required status check, doesn’t pass it', () => {
  const runs = edited(MERGED, (r) => (r.name === 'CodeQL' ? { ...r, conclusion: 'skipped' } : null));
  assert.equal(evaluate(REQUIRED, runs).exit, EXIT.fail);
  const skippedContext = edited(MERGED, (r) => (r.name === 'New and changed specs, ten times' ? { ...r, conclusion: 'skipped' } : null));
  assert.equal(evaluate(REQUIRED, skippedContext).exit, EXIT.pass);
});

test('a required check still running is pending, not a pass', () => {
  const runs = edited(MERGED, (r) => (r.name === 'CodeQL' ? { ...r, status: 'in_progress', conclusion: null } : null));
  const v = evaluate(REQUIRED, runs);
  assert.equal(v.exit, EXIT.pending);
  assert.match(report(840, MERGED.head, v).at(-1), /codeql=pending .*-> PENDING$/);
});

test('CodeQL’s result while an analysis still runs is pending, whichever way it reads: GitHub updates it per upload', () => {
  // Seen on #903 at 717fc318: CodeQL read as failed at 08:06 while Analyze (javascript-typescript) was still running,
  // and as success once its upload landed. Neither reading is final until every run has ended.
  const analysing = (conclusion) =>
    edited(MERGED, (run) => {
      if (run.name === 'CodeQL') return { ...run, conclusion };
      if (run.name.startsWith('Analyze')) return { ...run, status: 'in_progress', conclusion: null };
    });
  for (const conclusion of ['failure', 'success']) {
    const v = evaluate(REQUIRED, analysing(conclusion));
    assert.equal(v.exit, EXIT.pending, `CodeQL ${conclusion} with an analysis running`);
    assert.equal(v.rows.find((r) => r.name === 'CodeQL').state, 'pending');
  }
});

test('a missing required check is “not started” while other runs go, and missing once none do', () => {
  const demo = 'Demo in Chrome, with accessibility checks';
  const withoutDemo = MERGED.check_runs.filter((r) => r.name !== demo);
  assert.equal(evaluate(REQUIRED, withoutDemo).exit, EXIT.fail, 'nothing running: missing');
  const running = withoutDemo.map((r) => (r.name === 'Browser specs (plain, 1/3)' ? { ...r, status: 'in_progress', conclusion: null } : r));
  const v = evaluate(REQUIRED, running);
  assert.equal(v.exit, EXIT.pending);
  assert.ok(report(840, MERGED.head, v).includes(`not started: ${demo} (required)`));
});

test('a rerun replaces the run before it: the newest attempt of a name decides', () => {
  const name = 'Lint, types, project rules and tests';
  const older = { name, status: 'completed', conclusion: 'failure', started_at: '2026-11-06T01:00:00Z' };
  const newer = { name, status: 'completed', conclusion: 'success', started_at: '2026-11-06T02:00:00Z' };
  assert.equal(latestByName([newer, older]).get(name), newer);
  assert.equal(latestByName([older, newer]).get(name), newer);
  const recorded = NO_CODEQL.check_runs.filter((r) => r.name === name);
  assert.ok(recorded.length > 1, 'the recorded head has reruns');
});

test('signoffChecks reads the PR’s head and its base’s rules through gh, and a gh failure is an error, not a pass', () => {
  /** @type {string[][]} */
  const calls = [];
  const gh = (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === 'repo') return { nameWithOwner: 'o/r' };
    if (args[0] === 'pr') return { headRefOid: NO_CODEQL.head, baseRefName: 'main' };
    if (args[1].includes('/rules/')) return RULES;
    return [{ check_runs: NO_CODEQL.check_runs }];
  };
  const lines = [];
  assert.equal(signoffChecks(783, { gh, log: (l) => lines.push(l) }), EXIT.fail);
  assert.deepEqual(calls[2], ['api', 'repos/o/r/rules/branches/main']);
  assert.ok(calls[3].includes(`repos/o/r/commits/${NO_CODEQL.head}/check-runs?per_page=100`));
  assert.match(lines.at(-1), /codeql=missing/);
  const broken = () => {
    throw new Error('HTTP 502: Bad Gateway\nmore');
  };
  const out = [];
  assert.equal(signoffChecks(783, { gh: broken, log: (l) => out.push(l) }), EXIT.error);
  assert.deepEqual(out, ['signoff-checks #783: gh failed: HTTP 502: Bad Gateway -> ERROR']);
});
