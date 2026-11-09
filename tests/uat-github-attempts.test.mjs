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
  // A search that succeeds, printing a 401 it found in a file: no refusal, though the words are there.
  const read = call('grep -n 401 notes.md', '3: gh answered HTTP 401: Bad credentials', false);
  assert.deepEqual(githubAttempts([local, usage, read]), []);
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
