// A UAT run’s workspace is a git repository of its own whose git user is a fixture person’s (#558): an agent’s harness
// reads the git user as who it works for, so a run’s agents, transcripts and event log carry no real name or email.
// It runs git, so it is a process test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_GIT } from '../../tools/fixture-person.mjs';
import { makeWorkspace } from '../../tools/uat/workspace.mjs';

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test('the workspace’s git user is the fixture person’s, set in the repository, and its commits are theirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-uat-ws-'));
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    makeWorkspace({ seed: null, files: null }, { workspace }, dir);
    assert.deepEqual(
      ['user.name', 'user.email'].map((k) => git(workspace, ['config', '--local', k]).stdout.trim()),
      [FIXTURE_GIT.name, FIXTURE_GIT.email],
    );
    // What a harness reads, and what a commit an agent makes there carries.
    assert.equal(git(workspace, ['config', 'user.name']).stdout.trim(), 'Robin Example');
    assert.equal(git(workspace, ['commit', '--allow-empty', '-q', '-m', 'a commit']).status, 0);
    assert.equal(git(workspace, ['log', '-1', '--format=%an <%ae>']).stdout.trim(), 'Robin Example <robin@example.com>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
