// A UAT run whose folder is reached through a link still finds its agents’ Claude Code transcripts (#932). Claude
// Code names a project’s transcript folder from the real path of its working folder, so the runner has to resolve the
// run’s workspace before it builds that name; given the link’s path, it found none, and every delivery check said it
// couldn’t read what reached the agents.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeTranscriptFile } from '../tools/uat/claude-transcript-file.mjs';
import { readTranscripts } from '../tools/uat/run-files.mjs';
import { tempDir } from './temp-dirs.mjs';

/** One agent with a Claude Code session, in one thread: the shape readTranscripts reads. */
const facts = {
  threads: ['th_1'],
  state: {
    threads: { th_1: { members: ['se_1'] } },
    sessions: { se_1: { handle: 'researcher', backendState: { claudeSessionId: 'cs-1' } } },
  },
};
const LINE = JSON.stringify({ type: 'user', message: { content: 'the prompt' } });

/** A home with a transcript filed under a workspace’s real path, as Claude Code files it, and a link to that workspace. */
function setUp() {
  const root = realpathSync(tempDir('uat-realpath-'));
  const home = join(root, 'home');
  const workspace = join(root, 'real', 'run', 'workspace');
  mkdirSync(workspace, { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const projects = join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 'cs-1.jsonl'), `${LINE}\n`);
  return { home, workspace, linked: join(root, 'link', 'run', 'workspace') };
}

/** Runs fn with HOME pointed at home, as os.homedir() reads it, and puts HOME back. */
function withHome(home, fn) {
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = was;
  }
}

test('a workspace reached through a link finds the transcript Claude Code filed under its real path (#932)', () => {
  const { home, linked } = setUp();
  const found = withHome(home, () => readTranscripts(facts, linked));
  assert.deepEqual(
    found.map((t) => t.handle),
    ['researcher'],
  );
  assert.equal(found[0].lines[0], LINE);
});

test('a workspace given by its real path still finds it', () => {
  const { home, workspace } = setUp();
  const found = withHome(home, () => readTranscripts(facts, workspace));
  assert.deepEqual(
    found.map((t) => t.handle),
    ['researcher'],
  );
});

test('a workspace that doesn’t exist finds nothing, and doesn’t throw', () => {
  const { home, workspace } = setUp();
  assert.deepEqual(
    withHome(home, () => readTranscripts(facts, `${workspace}-gone`)),
    [],
  );
});

test('the helper both readers use names the folder from the real path, as Claude Code does', () => {
  const { home, workspace, linked } = setUp();
  const projects = join(home, '.claude', 'projects');
  assert.equal(claudeTranscriptFile(projects, linked, 'cs-1'), claudeTranscriptFile(projects, workspace, 'cs-1'));
  assert.equal(claudeTranscriptFile(projects, linked, 'cs-1'), join(projects, workspace.replace(/[^a-zA-Z0-9]/g, '-'), 'cs-1.jsonl'));
});
