// A run’s report says when an agent tried to reach GitHub and the run’s guard refused it (#1072, after #1061). The
// stream is a recorded Claude Code turn (2.1.319, Haiku), run under the guard’s environment in a temp folder: `gh api
// user` and `git ls-remote https://…`, each its own Bash call. It’s trimmed to the events the runner reads, with the
// tool calls and their results kept verbatim, except that the repository in the git URL is example/repo.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubAttempts, githubSection } from '../tools/uat/github-attempts.mjs';
import { writeReport } from '../tools/uat/report.mjs';

const recorded = readFileSync(new URL('./fixtures/uat/github-attempts-stream.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const streams = [{ handle: 'developer', started: 1, events: recorded }];

/** One Bash call and what it gave back, shaped as the recorded turn’s. */
const call = (command, content, isError) => ({
  handle: 'researcher',
  events: [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: isError, content }] } },
  ],
});

test('gh with no login and git refused https are each an attempt the guard refused', () => {
  assert.deepEqual(githubAttempts(streams), [
    { handle: 'developer', command: 'gh api user', what: 'gh has no login (HTTP 401)' },
    { handle: 'developer', command: 'git ls-remote https://github.com/example/repo.git', what: 'git is refused https' },
  ]);
});

test('a call the guard didn’t refuse isn’t one: a local push, a gh that failed for its own reason, or a read of the words', () => {
  const local = call('git push origin work', 'To /tmp/run/remote.git\n * [new branch]      work -> work', false);
  const usage = call('gh nope', 'Exit code 1\nunknown command "nope" for "gh"', true);
  // Reads that print gh’s and git’s exact words from a file an agent wrote: no gh or git ran, so no refusal (critic’s
  // read of #1112 at b5c37729).
  const reads = [
    call('grep "Bad credentials" notes.md', 'gh: Bad credentials (HTTP 401)', false),
    call('cat notes.md', "Saw this:\nfatal: transport 'https' not allowed", false),
    call('grep -n "token" notes.md', '4:  - The token in GH_TOKEN is invalid.', false),
    call('npm test', 'Exit code 1\nnot ok 2 - prints\n  HTTP 401: Bad credentials (https://api.github.com/graphql)', true),
  ];
  assert.deepEqual(githubAttempts([local, usage, ...reads]), []);
});

test('a refusal counts when one segment of the command runs gh or git, behind a pipe, an || or an env prefix', () => {
  const tried = githubAttempts([
    call('cd sub && git push origin main 2>&1 | tail -3', "fatal: transport 'https' not allowed", false),
    call('gh api user || true', 'gh: Bad credentials (HTTP 401)', false),
    call('env GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/example/repo.git', "Exit code 128\nfatal: transport 'https' not allowed", true),
    call('/usr/bin/git fetch origin; echo done', "fatal: transport 'https' not allowed\ndone", false),
    call('printf %s "$Q" | gh api graphql --input -', 'gh: Bad credentials (HTTP 401)', false),
  ]);
  assert.equal(tried.length, 5, JSON.stringify(tried));
});

test('the report says which agent tried what, and says nothing when none did', async (t) => {
  assert.deepEqual(githubSection([]), []);
  const dir = mkdtempSync(join(tmpdir(), 'uat-github-attempts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facts = { streams, kiroStreams: [], agyStreams: [], state: null, probes: {}, samples: [] };
  const quiet = t.mock.method(console, 'log', () => {});
  await writeReport({ dir, scenario: { title: 'GitHub' }, issues: [], findings: [], timeline: [], started: 0, tester: { spent: 0 }, facts, logLines: [] });
  quiet.mock.restore();
  assert.match(
    readFileSync(join(dir, 'report.md'), 'utf8'),
    /\*\*Agents tried to reach GitHub, and the run’s guard refused it:\*\* @developer `gh api user` \(gh has no login \(HTTP 401\)\); @developer `git ls-remote https:\/\/github\.com\/example\/repo\.git` \(git is refused https\)\./,
  );
});

// From critic’s read of #1112. gh’s three wordings under the run’s refused token, as `gh api user`, `gh pr list` and
// `gh auth status` print them (gh 2.102.0, recorded on a Mac under the guard’s environment).
const ghPrList = 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com';
const ghStatus =
  'Exit code 1\ngithub.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  - Active account: true\n  - The token in GH_TOKEN is invalid.';

test('a refused call counts when a pipe hides its exit code, and gh auth status’s wording counts too', () => {
  const tried = githubAttempts([
    call('gh pr list 2>&1 | head -5', ghPrList, false),
    call('git push origin main 2>&1 | tail -3', "fatal: transport 'https' not allowed", false),
    call('gh auth status', ghStatus, true),
  ]);
  assert.deepEqual(
    tried.map((a) => a.what),
    ['gh has no login (HTTP 401)', 'git is refused https', 'gh has no login (HTTP 401)'],
  );
});

test('another service’s 401, or a 401 a command printed, isn’t gh’s', () => {
  const chained = call('grep -n 401 notes.md && gh nope', 'Exit code 1\n3: answers HTTP 401\nunknown command "nope" for "gh"', true);
  const tests = call('npm test', 'Exit code 1\nnot ok 3 - the client answers HTTP 401: Bad credentials when the key is wrong', true);
  const curl = call('curl -sf https://api.example.com/me', 'Exit code 22\ncurl: (22) The requested URL returned error: 401', true);
  assert.deepEqual(githubAttempts([chained, tests, curl]), []);
});

test('a run that keeps the person’s GitHub (`- github: real`) has no guard, so the report says nothing of one', () => {
  assert.deepEqual(githubSection(streams, { github: 'real' }), []);
  assert.equal(githubSection(streams, {}).length, 2);
});
