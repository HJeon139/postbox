// #1856: an Antigravity agent with nothing to make a worktree from (its project’s folder isn’t in a git repository,
// the repository has no commit yet, or git refused the worktree) used to start in the project’s own folder, where
// every Antigravity turn waits for the one before it. It now starts in a folder of its own beside the project
// (server/adapters/agent-own-folder.mjs), with the project’s folder added to work in, so no turn waits for another
// agent’s. Git is a fake here, answering as git does; the same paths against real git are in tests/process/.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { besideNote, noWorktreeStep, ownFolderFor } from '../server/adapters/agent-own-folder.mjs';
import { agentPlace, agentWorktree, turnFolders, worktreeNote } from '../server/adapters/agent-worktree.mjs';
import { AntigravityCliAdapter } from '../server/adapters/antigravity-cli.mjs';
import { FolderQueue } from '../server/adapters/folder-queue.mjs';
import { tempDir } from './temp-dirs.mjs';

const A = { id: 'pe_Aaaa1111', handle: 'a' };
const B = { id: 'pe_Bbbb2222', handle: 'b' };

/**
 * A fake git for a project folder: `none` isn’t in a repository, `unborn` is in one with no commit yet, and `refused`
 * is in one whose `worktree add` git refuses, as for a branch checked out elsewhere.
 * @param {'none'|'unborn'|'refused'} kind @param {string} top
 * @returns {import('../server/adapters/agent-worktree.mjs').Git}
 */
const fakeGit = (kind, top) => async (_cwd, given) => {
  const args = given[0] === '-c' ? given.slice(2) : given;
  if (kind === 'none') return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: `${top}\n\n`, stderr: '' };
  if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') return { code: kind === 'unborn' ? 1 : 0, stdout: '', stderr: '' };
  if (args[0] === 'worktree' && args[1] === 'add') return { code: 128, stdout: '', stderr: "fatal: 'postbox/x-a' is already checked out at '/elsewhere'\n" };
  return { code: 1, stdout: '', stderr: '' };
};

/** A data folder with a project folder in it, and where each agent starts. @param {'none'|'unborn'|'refused'} kind */
function rig(kind) {
  const data = tempDir('pb-own-');
  const workRoot = join(data, 'work');
  const project = { id: 'pr_AbCd1234', folder: join(data, 'project') };
  mkdirSync(project.folder, { recursive: true });
  /** @type {string[]} */
  const logs = [];
  const o = { git: fakeGit(kind, project.folder), log: (/** @type {string} */ l) => logs.push(l) };
  return { data, workRoot, project, logs, o, placeOf: (/** @type {any} */ persona) => agentPlace(persona, project, workRoot, o) };
}

for (const [kind, what] of /** @type {const} */ ([
  ['none', 'a project that isn’t in a git repository'],
  ['unborn', 'a repository with no commit yet'],
])) {
  test(`#1856 two agents in ${what} each start in a folder of their own, and neither turn waits`, async () => {
    const r = rig(kind);
    const [a, b] = await Promise.all([r.placeOf(A), r.placeOf(B)]);
    assert.equal(a.folder, ownFolderFor(r.workRoot, r.project, A));
    assert.equal(b.folder, ownFolderFor(r.workRoot, r.project, B));
    assert.notEqual(a.folder, b.folder);
    assert.ok(existsSync(a.folder) && existsSync(b.folder), 'made');
    assert.equal(a.why, undefined, 'nothing failed: there was nothing to make a worktree from');
    assert.deepEqual(r.logs, []);
    // They work in the project’s folder, which each turn is given beside its own.
    assert.deepEqual(turnFolders(a.folder, { project: r.project }, r.workRoot).addDirs, [r.project.folder]);
    assert.equal(await agentWorktree(A, r.project, r.workRoot, r.o), r.project.folder, 'where the person’s `!` commands run');
    // So their turns don’t wait for each other: the queue is by the folder a turn starts in.
    const queue = new FolderQueue();
    let release = () => {};
    const held = new Promise((done) => {
      release = () => done(undefined);
    });
    const first = queue.run(a.folder, () => held);
    assert.equal(queue.busy(b.folder), false, 'b’s turn starts while a’s runs');
    release();
    await first;
  });
}

test('#1856 a worktree git refuses puts the agent in its own folder, not behind the others, and says why', async () => {
  const r = rig('refused');
  const place = await r.placeOf(A);
  assert.equal(place.folder, ownFolderFor(r.workRoot, r.project, A));
  assert.notEqual(place.folder, r.project.folder, 'not the folder every other turn would wait in');
  assert.match(place.why ?? '', /already checked out/);
  // The person’s `!` commands, the files it names and the permissions panel are for the folder it works in, as on
  // main: its own folder holds nothing between turns.
  assert.equal(await agentWorktree(A, r.project, r.workRoot, r.o), r.project.folder, 'commands, files and the panel are in the project’s folder');
  assert.equal(r.logs.length, 1, 'the server log says it once');
});

test('#1856 an agent in its own folder is told where the project is, and when git refused its worktree', () => {
  const r = rig('none');
  const own = ownFolderFor(r.workRoot, r.project, A);
  const plain = besideNote(own, r.project, r.workRoot);
  assert.match(plain, /^## Where you work\n\n/);
  assert.ok(plain.includes(`The project’s folder is ${r.project.folder}`), plain);
  assert.match(plain, /other agents work there at the same time/i);
  assert.doesNotMatch(plain, /git worktree/);
  const refused = besideNote(own, r.project, r.workRoot, 'fatal: it is already checked out');
  assert.match(refused, /couldn’t make you a git worktree \(fatal: it is already checked out\)/);
  assert.match(refused, /say so in your reply/);
  // Brief, as the worktree’s note is: agy’s rules file has about 750 characters to spare.
  assert.ok(refused.length - r.project.folder.length < 600, String(refused.length));
  // Only for a turn that starts in such a folder: not in the project’s folder, a persona’s own, or a worktree.
  assert.equal(besideNote(r.project.folder, r.project, r.workRoot), '');
  assert.equal(besideNote(join(r.workRoot, 'a'), r.project, r.workRoot), '');
  assert.equal(worktreeNote(own, A, r.project, r.workRoot), '', 'and the worktree’s note isn’t for it');
});

test('#1856 a worktree git refused is a failed step in the room, with git’s reason and what happens next', () => {
  const r = rig('refused');
  /** @type {any[]} */
  const steps = [];
  noWorktreeStep({ activity: (/** @type {any} */ s) => steps.push(s) }, A, r.project, 'fatal: it is already checked out');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, 'failed');
  assert.equal(steps[0].label, 'Postbox couldn’t make this agent’s worktree');
  assert.ok(steps[0].detail.includes('fatal: it is already checked out') && steps[0].detail.includes(r.project.folder), steps[0].detail);
  assert.match(steps[0].detail, /tries again at its next turn/);
  noWorktreeStep({ activity: (/** @type {any} */ s) => steps.push(s) }, A, r.project, undefined);
  assert.equal(steps.length, 1, 'no step when nothing failed');
});

const recorded = readFileSync(new URL('fixtures/antigravity-cli/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

/** A fake agy that keeps where it was started and with what, and plays a recorded turn. @param {any[]} seen */
const fakeSpawn = (seen) => (/** @type {string} */ _bin, /** @type {string[]} */ args, /** @type {{ cwd: string }} */ opts) => {
  const rules = join(opts.cwd, '.agents', 'plugins', 'postbox', 'rules', 'AGENTS.md');
  seen.push({ args, cwd: opts.cwd, rules: existsSync(rules) ? readFileSync(rules, 'utf8') : '' });
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
  setImmediate(() => {
    /** @type {any} */ (child).stdout.end(`${recorded.join('\n')}\n`);
    /** @type {any} */ (child).stderr.end('');
    setImmediate(() => child.emit('close', 0));
  });
  return child;
};

test('#1856 a turn whose worktree git refused runs in the agent’s own folder with the project’s added, and the room and the agent are told', async () => {
  const r = rig('refused');
  /** @type {any[]} */
  const seen = [];
  const adapter = new AntigravityCliAdapter({
    bin: 'agy',
    workRoot: r.workRoot,
    settingsFile: join(r.data, 'settings.json'),
    spawnImpl: /** @type {any} */ (fakeSpawn(seen)),
    env: {},
    git: r.o.git,
  });
  /** @type {any[]} */
  const steps = [];
  /** @type {any[]} */
  const statuses = [];
  const ctx = {
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    // Run everything with Web on needs no hook, and its rules carry the note on where it works.
    persona: { ...A, model: 'gemini-3.8-flash-high', permissionMode: 'bypass', tools: ['web.fetch'], description: '', instructions: '' },
    project: r.project,
    handles: ['a'],
    state: {},
    saveState: () => {},
    pathOf: () => null,
    text: () => {},
    activity: (/** @type {any} */ s) => steps.push(s),
    status: (/** @type {any} */ s) => statuses.push(s),
    reported: () => {},
  };
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, ownFolderFor(r.workRoot, r.project, A));
  const added = seen[0].args.indexOf('--add-dir');
  assert.equal(seen[0].args[added + 1], r.project.folder, 'the project’s folder is one it works in');
  assert.match(seen[0].rules, /couldn’t make you a git worktree \(fatal: 'postbox\/x-a' is already checked out/);
  assert.deepEqual(
    steps.filter((s) => s.state === 'failed').map((s) => s.label),
    ['Postbox couldn’t make this agent’s worktree'],
  );
  assert.ok(!statuses.some((s) => /Waiting for another Antigravity turn/.test(s.currentStep ?? '')), 'it waited for no one');
});
