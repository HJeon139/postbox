// #362 item 4: when a background command ends, the ledger reads the tail of the output file the backend names
// (server/ledger.mjs, taskEnded) and Work shows it to the person. A backend's stream names that path, so it's read
// only inside the agent's own folders or the backend's own folder under the temp folder (claude, claude-<uid>), with
// links followed first.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Ledger } from '../server/ledger.mjs';
import { nodeIo, outputFileAt } from '../server/ledger-io.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';
import { fakeGit, memIo } from './work-replay.mjs';

const FOLDER = '/work/proj';
/** A ledger over files in memory, where `links` maps a path to where it resolves. */
function ledgerWith(files, links = {}) {
  const store = new Store(null);
  const io = { ...memIo(files), realPath: async (p) => links[p] ?? p, tempRoots: () => ['/scratch'] };
  const ledger = new Ledger({ store, io, git: fakeGit([]), now: () => 1000 });
  store.emit('thread', { id: 'th_1', kind: 'thread', members: [] });
  return { store, ledger };
}

/** The output Work keeps for a background command whose output file is `outputFile`, and how it ended. */
async function outputOf(files, outputFile, links, folder = FOLDER) {
  const { store, ledger } = ledgerWith(files, links);
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder, projectFolder: FOLDER });
  ledger.toolUse(turn, { id: 'a', name: 'Bash', input: { command: 'make', run_in_background: true } });
  ledger.toolResult(turn, { id: 'a', text: 'Command running in background', result: { backgroundTaskId: 'b_a' } });
  await ledger.idle();
  ledger.taskEnded(turn, { toolUseId: 'a', status: 'completed', summary: 'exit code 0', outputFile });
  await ledger.idle();
  const cmd = store.state.work.th_1.find((e) => e.kind === 'command');
  // The command's own result ("Command running in background") is its output until a file's tail replaces it.
  const fromFile = !!cmd.output && cmd.output.size === files[outputFile]?.length;
  return { fromFile, state: cmd.state };
}

const SECRET = { '/home/me/.ssh/id_rsa': 'PRIVATE KEY', '/etc/shadow': 'root:hash' };

test('#362: an output file in the agent’s folder or in the backend’s temp folder is read', async () => {
  const files = {
    [`${FOLDER}/build.log`]: 'built "<&>"',
    '/scratch/claude-u/-work-proj/s1/tasks/b_a.output': 'done',
    '/scratch/claude/-w/s/tasks/x.output': 'ok',
  };
  for (const path of [`${FOLDER}/build.log`, '/scratch/claude-u/-work-proj/s1/tasks/b_a.output', '/scratch/claude/-w/s/tasks/x.output'])
    assert.equal((await outputOf(files, path)).fromFile, true, path);
});

test('#362: an output file anywhere else is not read, and the command still ends', async () => {
  const files = { ...SECRET, '/scratch/other/x.output': 's', '/scratch/claudette/x': 's', '/work/projx/a.log': 's' };
  for (const path of ['/home/me/.ssh/id_rsa', '/etc/shadow', '/scratch/other/x.output', '/scratch/claudette/x', '/work/projx/a.log'])
    assert.deepEqual(await outputOf(files, path), { fromFile: false, state: 'done' }, path);
});

test('#362: an output file whose path leads outside through a link is not read', async () => {
  const links = { [`${FOLDER}/out.log`]: '/home/me/.ssh/id_rsa', '/scratch/claude-u/t.output': '/etc/shadow' };
  const files = { ...SECRET, [`${FOLDER}/out.log`]: 'PRIVATE KEY', '/scratch/claude-u/t.output': 'root:hash' };
  assert.equal((await outputOf(files, `${FOLDER}/out.log`, links)).fromFile, false);
  assert.equal((await outputOf(files, '/scratch/claude-u/t.output', links)).fromFile, false);
});

test('#362: the agent’s own folder and the project’s each count, when they differ', async () => {
  const files = { '/agents/dev/run.log': 'agent', [`${FOLDER}/run.log`]: 'project' };
  assert.equal((await outputOf(files, '/agents/dev/run.log', {}, '/agents/dev')).fromFile, true, 'the agent’s folder');
  assert.equal((await outputOf(files, `${FOLDER}/run.log`, {}, '/agents/dev')).fromFile, true, 'the project’s folder');
});

// On the real filesystem, with nodeIo. Claude Code writes output files under the real /tmp, and Node’s temp folder can
// be somewhere else, as it is on a Mac. Each folder is a fresh name made here, so nothing else in /tmp matters.
const REAL_TMP = { skip: process.platform === 'win32' ? 'Windows has no /tmp' : false };

/** Moves Node’s temp folder away from /tmp for one test, as a Mac has it, and returns it. @param {any} t */
function nodeTempElsewhere(t) {
  const before = process.env.TMPDIR;
  const elsewhere = tempDir('node-temp-');
  t.after(() => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  });
  process.env.TMPDIR = elsewhere;
  return elsewhere;
}

/** Writes a file, making its folders. Returns its path. @param {string} path */
function fileAt(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'output');
  return path;
}

test('#362: a background output file in a backend’s folder under the real /tmp is read', REAL_TMP, async (t) => {
  const elsewhere = nodeTempElsewhere(t);
  for (const root of ['/tmp', elsewhere]) {
    const file = fileAt(join(tempDir('claude-output-', root), 'slug', 'tasks', 'b_a.output'));
    assert.equal(await outputFileAt(nodeIo, {}, file), realpathSync(file), file);
  }
});

test('#362: under the real /tmp, only what’s inside a backend’s own real folder is read', REAL_TMP, async (t) => {
  const elsewhere = nodeTempElsewhere(t);
  const secret = fileAt(join(elsewhere, 'secrets', 'id_rsa'));
  const backend = tempDir('claude-output-', '/tmp');
  const linkedFolder = `${backend}-linked`;
  const looseFile = `${backend}.log`;
  t.after(() => rmSync(linkedFolder, { force: true }));
  t.after(() => rmSync(looseFile, { force: true }));
  symlinkSync(dirname(secret), linkedFolder);
  writeFileSync(looseFile, 'not in a folder');
  const linkOut = join(backend, 'out.output');
  symlinkSync(secret, linkOut);
  const claudette = fileAt(join(tempDir('claudette-output-', '/tmp'), 'x.output'));
  const project = join(elsewhere, 'project');
  const projectSibling = fileAt(join(elsewhere, 'projectx', 'a.log'));
  mkdirSync(project);
  const work = { folder: project, projectFolder: project };

  const refused = {
    'a link out of the folder': linkOut,
    'a claude-* folder that’s a link': join(linkedFolder, 'id_rsa'),
    'a claudette folder': claudette,
    'a file, not a folder, named claude-*': looseFile,
    'a path that climbs out with ..': `${backend}/../${claudette.slice('/tmp/'.length)}`,
    'a sibling of the project': projectSibling,
    'a system file': '/etc/hosts',
  };
  for (const [what, path] of Object.entries(refused)) assert.equal(await outputFileAt(nodeIo, work, path), null, what);
});
