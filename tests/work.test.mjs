import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { commandFacts, diffCount, diffRows, externalTool, fileState, flagged, hunks, splitLines, summarize, turnLine } from '../shared/work.mjs';

// Streams recorded from real Claude Code turns (claude 2.1.309, claude-haiku-5-5), with local paths removed.
const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** Files in memory, in the shape server/ledger.mjs reads and writes them. */
function memIo(initial = {}) {
  const fs = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const read = (p) => (fs.has(p) ? { exists: true, size: fs.get(p).length, bytes: Buffer.from(fs.get(p)) } : { exists: false });
  return {
    fs,
    text: (p) => fs.get(p)?.toString('utf8'),
    readNow: read,
    read: async (p) => read(p),
    readTail: async (p) => {
      if (!fs.has(p)) throw new Error('ENOENT');
      return { bytes: fs.get(p), cut: false };
    },
    writeAtomic: async (p, b) => {
      fs.set(p, Buffer.from(b));
    },
    remove: async (p) => {
      fs.delete(p);
    },
  };
}

/** git, answered from a table of argument lines; anything else fails as git would outside a repository. */
function fakeGit(table) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push(`${cwd} $ git ${args.join(' ')}`);
    for (const [pattern, answer] of table) if (pattern.test(`${cwd} ${args.join(' ')}`)) return { code: 0, stderr: '', ...answer };
    return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
  };
  return Object.assign(git, { calls });
}

// ── Counting ────────────────────────────────────────────────────────────────────────────

test('lines are counted from the diff, as git counts them', () => {
  assert.deepEqual(diffCount('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n'), { added: 1, deleted: 1 });
  assert.deepEqual(diffCount('', '# Hello'), { added: 1, deleted: 0 });
  assert.deepEqual(diffCount('a\nb\n', ''), { added: 0, deleted: 2 });
  // Taking away the final newline changes the last line, as in git.
  assert.deepEqual(diffCount('scratch\n', 'scratch'), { added: 1, deleted: 1 });
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  // Five edits that end where they began count as nothing.
  assert.deepEqual(diffCount('a\nb\nc\n', 'a\nb\nc\n'), { added: 0, deleted: 0 });
  assert.deepEqual(diffCount('a\nb\nc\nd\ne\n', 'a\nx\nc\ne\nf\n'), { added: 2, deleted: 2 });
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(diffCount(`${big}\n`, `${big.replace('line 2500', 'changed')}\nextra\n`), { added: 2, deleted: 1 });
});

test('a diff to show has line numbers on both sides, and hunks fold what didn’t change', () => {
  const rows = diffRows('a\nb\nc\n', 'a\nB\nc\nd');
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.t}:${r.o ?? ''}:${r.n ?? ''}`),
    ['same:a:1:1', 'del:b:2:', 'add:B::2', 'same:c:3:3', 'add:d::4'],
  );
  const long = Array.from({ length: 40 }, (_, i) => String(i)).join('\n');
  const h = hunks(diffRows(`${long}\n`, `${long.replace('\n20\n', '\nTWENTY\n')}\n`));
  assert.deepEqual(
    h.map((r) => (r.kind === 'gap' ? `…${r.skipped}` : r.kind[0] + r.t)),
    ['…17', 's17', 's18', 's19', 'd20', 'aTWENTY', 's21', 's22', 's23', '…16'],
  );
});

test('commands say what they did to version control and to services outside Postbox', () => {
  const push = commandFacts(
    "git checkout -b feature && git commit -am 'Second' && git push -u origin feature",
    '[feature 15ae03c] Second\n 1 file changed\nTo /workspace/remote.git\n * [new branch]      feature -> feature\n',
  );
  assert.deepEqual(push.branches, ['feature']);
  assert.deepEqual(push.commit, { branch: 'feature', sha: '15ae03c', message: 'Second' });
  assert.deepEqual(push.push, { remote: '/workspace/remote.git', refs: ['feature → feature'] });
  const pr = commandFacts('gh pr create --title "Kiro adapter" --body x', 'https://github.com/HJeon139/postbox/pull/127\n');
  assert.deepEqual(pr.external, [{ kind: 'gh', what: 'gh pr create', urls: ['https://github.com/HJeon139/postbox/pull/127'] }]);
  assert.equal(commandFacts('gh pr view 127', 'title: x').external.length, 0, 'reading isn’t writing');
  assert.equal(commandFacts('gh api repos/o/r/issues/1/comments -X POST -f body=hi', '').external[0].what, 'gh api POST');
  assert.deepEqual(commandFacts('git branch -d old').branches, []);
  assert.deepEqual(externalTool('mcp__github__create_pull_request'), { server: 'github', tool: 'create_pull_request' });
  assert.equal(externalTool('mcp__github__get_file_contents'), null);
  assert.equal(externalTool('mcp__postbox__show_block'), null, 'Postbox’s own tools only show things in the thread');
});

// ── Recorded turns, through the stream mapper and the ledger ────────────────────────────

/**
 * Replays a recorded turn into a ledger. The tools’ effects on the files are applied as the recording says they
 * happened. raced: each main-agent edit lands before Postbox reads the file, as when the tool wins the race; the
 * tool’s own record of the file (originalFile) must then set it right.
 */
async function replayLedger(name, { files = {}, git = fakeGit([]), raced = false, extra = {} } = {}) {
  const store = new Store(null);
  const io = memIo(files);
  for (const [k, v] of Object.entries(extra)) io.fs.set(k, Buffer.from(v));
  let t = 0;
  const ledger = new Ledger({ store, io, git, home: '/home/me', now: () => (t += 100) });
  store.emit('thread', { id: 'th_1', kind: 'thread', projectId: 'p1', members: [] });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder: '/workspace/rec', projectFolder: '/workspace/rec' });
  const inputs = new Map();
  const apply = (id, r) => {
    const u = inputs.get(id);
    if (!u) return;
    if (u.name === 'Write') io.fs.set(u.input.file_path, Buffer.from(u.input.content));
    if (u.name === 'Edit') io.fs.set(u.input.file_path, Buffer.from(io.text(u.input.file_path).replace(u.input.old_string, u.input.new_string)));
    u.applied = true;
    return r;
  };
  const ctx = {
    text() {},
    activity() {},
    status() {},
    compaction() {},
    toolUse(u) {
      inputs.set(u.id, u);
      if (raced && !u.who) apply(u.id);
      ledger.toolUse(turn, u);
    },
    toolResult(r) {
      if (!inputs.get(r.id)?.applied) apply(r.id);
      ledger.toolResult(turn, r);
    },
    taskEnded: (x) => ledger.taskEnded(turn, x),
    usage: (u) => ledger.usage(turn, u),
  };
  const m = createStreamMapper(ctx, { now: () => 1000 });
  for (const e of fixture(name)) m.push(e);
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
  const entries = store.state.work.th_1;
  const of = (kind) => entries.filter((e) => e.kind === kind);
  return { store, ledger, io, entries, of, turn };
}

const REC = [
  [/rev-parse --show-toplevel/, { stdout: '/workspace/rec\n' }],
  [/ls-files --error-unmatch -- notes\.txt/, { stdout: 'notes.txt\n' }],
  [/ls-files --error-unmatch/, { code: 1, stdout: '' }],
  [/show .*0e1af64/, { stdout: `${'a'.repeat(40)}\x1fLedger test\n\n1\t0\thello.md\n1\t1\tnotes.txt\n1\t0\tuntracked.txt\n` }],
  [/show .*15ae03c/, { stdout: `${'b'.repeat(40)}\x1fSecond\n\n1\t1\thello.md\n` }],
];

test('a recorded turn’s edits: each file’s lines from its diff, and the file git didn’t track is flagged with a copy from before', async () => {
  for (const raced of [false, true]) {
    const { of, ledger } = await replayLedger('ledger-edits', {
      files: { '/workspace/rec/notes.txt': 'alpha\nbeta\ngamma\n', '/workspace/rec/untracked.txt': 'scratch\n' },
      extra: { '/tmp/claude/-workspace-rec/5f0c2b1e-6a3d-4e7f-9c21-0d4a8b7e1324/tasks/b0jpulo0v.output': 'bg-done\n\n[exited with code 0]\n' },
      git: fakeGit(REC),
      raced,
    });
    const files = Object.fromEntries(of('file').map((f) => [f.rel, f]));
    assert.deepEqual(Object.keys(files).sort(), ['hello.md', 'notes.txt', 'untracked.txt'], `raced: ${raced}`);
    assert.deepEqual([files['notes.txt'].added, files['notes.txt'].deleted], [1, 1]);
    assert.deepEqual([files['hello.md'].added, files['hello.md'].deleted, files['hello.md'].existed], [1, 0, false]);
    assert.deepEqual([files['untracked.txt'].added, files['untracked.txt'].deleted], [1, 1], `raced: ${raced}: the tool’s record of the file before wins`);
    assert.equal(files['notes.txt'].tracked, true);
    assert.equal(files['untracked.txt'].tracked, false);
    assert.equal(flagged(files['untracked.txt'], null), true, 'it existed, and git can’t give it back');
    assert.equal(flagged(files['notes.txt'], null), false);
    assert.equal(flagged(files['hello.md'], null), false, 'an agent made it');
    const diff = await ledger.fileDiff('th_1', files['untracked.txt'].id);
    assert.deepEqual(
      diff.rows.map((r) => `${r.kind}:${r.t}`),
      ['del:scratch', 'add:changed'],
    );
  }
});

test('a recorded turn’s commands: exactly as they ran, failures with their exit code, a background one with how it ended', async () => {
  const { of, ledger } = await replayLedger('ledger-edits', {
    files: { '/workspace/rec/notes.txt': 'alpha\nbeta\ngamma\n', '/workspace/rec/untracked.txt': 'scratch\n' },
    extra: { '/tmp/claude/-workspace-rec/5f0c2b1e-6a3d-4e7f-9c21-0d4a8b7e1324/tasks/b0jpulo0v.output': 'bg-done\n\n[exited with code 0]\n' },
    git: fakeGit(REC),
  });
  const cmds = of('command');
  assert.deepEqual(
    cmds.map((c) => [c.command.split(" -m 'Co")[0], c.state, c.exit]),
    [
      ['ls nope-missing', 'failed', 2],
      ['sleep 2; echo bg-done', 'done', 0],
      ["git add -A && git commit -m 'Ledger test'", 'done', 0],
    ],
  );
  assert.equal(await ledger.output('th_1', cmds[0].id), 'ls: cannot access ’nope-missing’: No such file or directory'.replace(/[’]/g, "'"));
  assert.equal(cmds[1].background, true);
  assert.equal(cmds[1].endedInBackground, true);
  assert.match(await ledger.output('th_1', cmds[1].id), /^bg-done/, 'the background command’s output comes from its output file');
  const [commit] = of('commit');
  assert.equal(commit.sha, 'a'.repeat(40), 'the full hash, from git');
  assert.equal(commit.branch, 'master');
  assert.equal(commit.cwd, '/workspace/rec', 'where Claude Code said the commit happened');
  assert.deepEqual([commit.files.length, commit.added, commit.deleted], [3, 3, 1], 'files and lines as git show counts them');
  const [turn] = of('turn');
  assert.equal(turn.toolCalls, 9);
  assert.equal(turn.costUsd, 0.0059721999999999996, 'the process’s last running total, not the sum of its results');
  assert.equal(turn.tokens.cacheRead, 235850);
});

test('a recorded turn that branched, put a file back, committed and pushed, with a subagent’s file', async () => {
  const { of } = await replayLedger('ledger-push', {
    files: { '/workspace/rec/notes.txt': 'alpha\nBETA\ngamma\n', '/workspace/rec/hello.md': '# Hello' },
    git: fakeGit(REC),
  });
  assert.deepEqual(
    of('file')
      .map((f) => `${f.rel} +${f.added} −${f.deleted}`)
      .sort(),
    ['hello.md +1 −1', 'sub.txt +1 −0'],
    'notes.txt was edited twice and put back, so it isn’t a change',
  );
  assert.equal(of('change').find((c) => c.who)?.who, 'general-purpose', 'the subagent that wrote it');
  assert.deepEqual(
    of('branch').map((b) => b.name),
    ['feature'],
  );
  const [push] = of('push');
  assert.deepEqual([push.branch, push.remote, push.refs], ['feature', '/workspace/remote.git', ['feature → feature']]);
  assert.equal(of('commit')[0].message, 'Second');
});

// ── Where it stands, and the totals ─────────────────────────────────────────────────────

test('git says whether each change is uncommitted, committed or pushed, with read-only commands', async () => {
  const git = fakeGit([
    ...REC,
    [/status --porcelain/, { stdout: ' M notes.txt\0?? new.txt\0' }],
    [/rev-parse --abbrev-ref HEAD/, { stdout: 'feature\n' }],
    [/@\{upstream\}/, { stdout: 'origin/feature\n' }],
    [/log -1 --format=%H -- hello\.md/, { stdout: `${'c'.repeat(40)}\n` }],
    [/log -1 --format=%H -- untracked\.txt/, { stdout: `${'d'.repeat(40)}\n` }],
    [/branch -r --contains c{40}/, { stdout: '  origin/feature\n' }],
    [/branch -r --contains (d{40}|a{40})/, { stdout: '' }],
  ]);
  const { ledger, entries } = await replayLedger('ledger-edits', {
    files: { '/workspace/rec/notes.txt': 'alpha\nbeta\ngamma\n', '/workspace/rec/untracked.txt': 'scratch\n' },
    git,
  });
  const g = await ledger.gitState('th_1');
  const by = Object.fromEntries(entries.filter((e) => e.kind === 'file').map((f) => [f.rel, g.files[f.id].state]));
  assert.deepEqual(by, { 'notes.txt': 'uncommitted', 'hello.md': 'pushed', 'untracked.txt': 'committed' });
  assert.deepEqual(g.repos, [{ root: '/workspace/rec', branch: 'feature', upstream: 'origin/feature' }]);
  assert.ok(
    git.calls.every((c) => / git (rev-parse|ls-files|show|status|log|branch -r|check-ignore|symbolic-ref|for-each-ref|rev-list|diff)\b/.test(c)),
    'nothing but reads',
  );
  assert.ok(
    git.calls.some((c) => c.includes('status --porcelain')),
    'status ran',
  );

  const s = summarize(entries, { git: g });
  assert.deepEqual(s.byState.uncommitted, { files: 1, added: 1, deleted: 1 });
  assert.deepEqual(s.byState.pushed, { files: 1, added: 1, deleted: 0 });
  assert.deepEqual(s.total, { files: 3, added: 3, deleted: 2 });
  // By agent, by state and in all, the counts add up.
  const agentSum = s.byAgent.reduce((n, a) => n + a.added, 0);
  const stateSum = Object.values(s.byState).reduce((n, x) => n + x.added, 0);
  assert.equal(agentSum, s.total.added);
  assert.equal(stateSum, s.total.added);
  assert.equal(s.flagged, 1);
  assert.equal(turnLine(entries, 'turn_1'), '3 files +3 −2 · 3 commands (1 failed) · 1 commit · 4 s in all · <$0.01');
});

test('effort that left nothing lasting is listed apart', () => {
  const entries = [
    { kind: 'turn', id: 't1', handle: 'dev', ms: 60000, toolCalls: 10, costUsd: 1.5 },
    { kind: 'turn', id: 't2', handle: 'dev', ms: 30000, toolCalls: 4, costUsd: 0.5 },
    { kind: 'turn', id: 't3', handle: 'critic', ms: 5000, toolCalls: 0, costUsd: 0.1 },
    {
      kind: 'file',
      id: 'f1',
      rel: 'a.js',
      before: { exists: true, sha256: 'x' },
      after: { exists: true, sha256: 'y' },
      added: 5,
      deleted: 1,
      lastHandle: 'dev',
    },
    {
      kind: 'file',
      id: 'f2',
      rel: 'b.js',
      before: { exists: true, sha256: 'p' },
      after: { exists: true, sha256: 'p' },
      added: 0,
      deleted: 0,
      lastHandle: 'dev',
    },
    { kind: 'change', id: 'c1', turnId: 't1', fileId: 'f1', handle: 'dev', added: 8, deleted: 1, before: { sha256: 'x' }, after: { sha256: 'z' } },
    { kind: 'change', id: 'c2', turnId: 't2', fileId: 'f2', handle: 'dev', added: 3, deleted: 3, before: { sha256: 'p' }, after: { sha256: 'q' } },
    { kind: 'command', id: 'k1', turnId: 't3', handle: 'critic', state: 'failed' },
  ];
  const s = summarize(entries);
  assert.deepEqual(
    s.idle.list.map((t) => t.id),
    ['t3'],
    'the turn whose only command failed; t2’s edit was put back since, but it’s in t2’s list, so it counts (#195)',
  );
  assert.equal(s.idle.costUsd, 0.1);
  assert.equal(s.effort.written, 11, 'lines written along the way');
  assert.equal(s.effort.kept, 5, 'and kept');
  assert.equal(fileState(entries[4], null), 'unchanged');
  assert.equal(s.total.files, 1, 'a file put back doesn’t count');
  assert.deepEqual(
    summarize(entries, { handle: 'critic' }).files.map((f) => f.id),
    [],
  );
});

// ── Restore, through the runtime ────────────────────────────────────────────────────────

function runtimeWith(io) {
  const store = new Store(null);
  const ledger = new Ledger({ store, io, git: fakeGit([]) });
  const adapter = {
    name: 'mock',
    next: [],
    async deliver(_se, _m, ctx) {
      await (this.next.shift() ?? ((c) => c.text('ok')))(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    ledger,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/proj' });
  const a = rt.createPersona({ handle: 'dev' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  return { rt, store, adapter, t, ledger };
}
const settle = async (rt) => {
  for (let i = 0; i < 100 && rt.turns.size; i++) await new Promise((r) => setTimeout(r, 5));
  await rt.ledger.idle();
  await new Promise((r) => setTimeout(r, 5));
};
/** An agent turn that edits a file the way Claude Code reports it. */
let calls = 0;
const edits = (io, path, next) => async (c) => {
  const id = `toolu_${++calls}`;
  c.activity({ id, label: 'Edited', state: 'running' });
  c.toolUse({ id, name: 'Write', input: { file_path: path, content: next } });
  const before = io.text(path) ?? null;
  io.fs.set(path, Buffer.from(next));
  c.toolResult({ id, text: 'ok', result: { type: before === null ? 'create' : 'update', originalFile: before } });
  c.activity({ id, label: 'Edited', state: 'done' });
  c.usage({ key: 'p', costUsd: 0.42, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
  c.text('Done.');
};

test('a turn’s work is recorded through the runtime, and its reply leads to it', async () => {
  const io = memIo({ '/proj/a.txt': 'one\n', '/home/me/.kiro/agent.json': '{}\n' });
  const { rt, store, adapter, t } = runtimeWith(io);
  adapter.next.push(async (c) => {
    await edits(io, '/proj/a.txt', 'one\ntwo\n')(c);
    await edits(io, '/home/me/.kiro/agent.json', '{"x":1}\n')(c);
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const work = store.state.work[t.id];
  const files = work.filter((e) => e.kind === 'file');
  assert.deepEqual(
    files.map((f) => [f.path, f.outside]),
    [
      ['/proj/a.txt', false],
      ['/home/me/.kiro/agent.json', true],
    ],
    'a change outside the project is flagged',
  );
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  assert.equal(reply.work, '2 files +2 −1 · $0.42');
  assert.equal(work.find((e) => e.kind === 'turn').status, 'done');
});

test('Restore puts a file back as it was, says so in the conversation, and won’t overwrite a newer change', async () => {
  const io = memIo({ '/proj/a.txt': 'one\n' });
  const { rt, store, adapter, t } = runtimeWith(io);
  adapter.next.push(edits(io, '/proj/a.txt', 'one\ntwo\n'));
  adapter.next.push(edits(io, '/proj/new.txt', 'made\n'));
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  rt.sendMessage(t.id, { text: 'more' });
  await settle(rt);
  const file = (p) => store.state.work[t.id].find((e) => e.kind === 'file' && e.path === p);

  // Changed since: refused, and nothing is written.
  io.fs.set('/proj/a.txt', Buffer.from('one\ntwo\nmine\n'));
  await assert.rejects(rt.restoreWork(t.id, file('/proj/a.txt').id), (e) => e.status === 409 && /changed after/.test(e.message));
  assert.equal(io.text('/proj/a.txt'), 'one\ntwo\nmine\n');

  io.fs.set('/proj/a.txt', Buffer.from('one\ntwo\n'));
  await rt.restoreWork(t.id, file('/proj/a.txt').id);
  assert.equal(io.text('/proj/a.txt'), 'one\n');
  assert.deepEqual([file('/proj/a.txt').added, file('/proj/a.txt').deleted, Boolean(file('/proj/a.txt').restored)], [0, 0, true]);
  // A file the agent created is removed.
  await rt.restoreWork(t.id, file('/proj/new.txt').id);
  assert.equal(io.fs.has('/proj/new.txt'), false);
  assert.deepEqual(
    store
      .items(t.id)
      .filter((i) => i.kind === 'voice')
      .map((i) => i.text),
    ['Restored a.txt to how it was before @dev changed it', 'Removed new.txt, which @dev created'],
    'the agents read it on their next turn',
  );
  await assert.rejects(rt.restoreWork(t.id, file('/proj/a.txt').id), (e) => e.status === 409);
});

test('a side thread’s work counts toward its conversation', async () => {
  const io = memIo({});
  const { rt, store, t, ledger } = runtimeWith(io);
  const side = rt.createThread({ projectId: 'p1', title: 'S', kind: 'side', parentId: t.id });
  assert.equal(ledger.convOf(side.id), t.id);
  await assert.rejects(
    Promise.resolve().then(() => rt.workGit(side.id)),
    (e) => e.status === 404,
  );
  assert.deepEqual(store.state.work[t.id] ?? [], []);
});

test('a command refused by the backend or declined on a permission card reads as refused, not failed', async () => {
  const store = new Store(null);
  const ledger = new Ledger({ store, io: memIo(), git: fakeGit([]) });
  store.emit('thread', { id: 'th_1', kind: 'thread', members: [] });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' } });
  ledger.toolUse(turn, { id: 'a', name: 'Bash', input: { command: 'rm -rf build' } });
  ledger.toolResult(turn, { id: 'a', isError: true, text: 'The person didn’t allow this. Their reason: not now' });
  ledger.toolUse(turn, { id: 'b', name: 'Bash', input: { command: 'rm copy.txt' } });
  ledger.denied(turn, 'b');
  ledger.toolResult(turn, { id: 'b', isError: true, text: 'Permission to use Bash with command rm copy.txt has been denied.' });
  ledger.toolUse(turn, { id: 'c', name: 'Bash', input: { command: 'sleep 600' } });
  await ledger.endTurn(turn, { status: 'stopped' });
  assert.deepEqual(
    store.state.work.th_1.filter((e) => e.kind === 'command').map((c) => c.state),
    ['denied', 'denied', 'stopped'],
    'and a command with no result when you stopped the turn stopped with it',
  );
});

test('a background command says what became of it after Stop: stopped with its agent, or kept running and how it ended (#164)', async () => {
  const store = new Store(null);
  let now = 1000;
  const ledger = new Ledger({ store, io: memIo(), git: fakeGit([]), now: () => now });
  store.emit('thread', { id: 'th_1', kind: 'thread', members: [] });
  const cmd = (id) => store.state.work.th_1.find((e) => e.kind === 'command' && e.toolUseId === id);
  const inBackground = (turn, id) => {
    ledger.toolUse(turn, { id, name: 'Bash', input: { command: `sleep 600 # ${id}`, run_in_background: true } });
    ledger.toolResult(turn, { id, text: 'Command running in background', result: { backgroundTaskId: `b_${id}` } });
  };
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' } });
  for (const id of ['a', 'b', 'c', 'd']) inBackground(turn, id);
  await ledger.idle();
  const job = (id) => ({ threadId: 'th_1', toolUseId: id });
  // Stop it too, heard before the turn ends: stopped, not left running.
  ledger.jobUpdate(job('a'), { state: 'stopped' });
  // Keep running, heard before the turn ends.
  ledger.jobUpdate(job('b'), { kept: true });
  ledger.jobUpdate(job('c'), { kept: true });
  now = 4000;
  await ledger.endTurn(turn, { status: 'stopped' });
  // Stop it too, heard after the turn ended: it was left running, and now isn’t.
  ledger.jobUpdate(job('d'), { state: 'stopped' });
  assert.deepEqual([cmd('a').state, !!cmd('a').leftRunning, cmd('a').ms], ['stopped', false, 0]);
  assert.deepEqual([cmd('d').state, !!cmd('d').leftRunning, cmd('d').ms], ['stopped', false, 3000]);
  assert.deepEqual([cmd('b').state, cmd('b').leftRunning, cmd('b').keptRunning], ['background', true, true], 'a kept job still reads as running');
  // Later, one ends on its own (Postbox saw its process go) and you stop the other.
  ledger.jobUpdate(job('b'), { state: 'done' });
  ledger.jobUpdate(job('c'), { state: 'stopped', by: 'you' });
  assert.deepEqual([cmd('b').state, !!cmd('b').leftRunning, cmd('b').keptRunning], ['unknown', false, true], 'its exit isn’t known');
  assert.deepEqual([cmd('c').state, cmd('c').stoppedBy], ['stopped', 'you']);
  // An end the CLI reported, with its exit, isn’t overwritten.
  const t2 = { id: 'turn_2', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(t2, { se: { id: 'se_1', handle: 'dev' } });
  inBackground(t2, 'e');
  await ledger.idle();
  ledger.taskEnded(t2, { toolUseId: 'e', status: 'completed', summary: 'exit code 0' });
  await ledger.idle();
  ledger.jobUpdate(job('e'), { state: 'stopped' });
  assert.equal(cmd('e').state, 'done');
});

test('the runtime tells Work when Stop keeps a job and when it ends', async () => {
  const io = memIo({});
  const { rt, store, adapter, t } = runtimeWith(io);
  rt.listProcesses = async () => [{ pid: 4242, ppid: 1, pgid: 4242, command: "/bin/zsh -c eval 'sleep 600' < /dev/null" }];
  rt.signalProcess = () => true;
  adapter.next.push(async (c) => {
    c.toolUse({ id: 'tu_1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } });
    c.toolResult({ id: 'tu_1', text: 'Command running in background', result: { backgroundTaskId: 'job1' } });
    c.job({ id: 'job1', toolUseId: 'tu_1', label: 'sleep 600', command: 'sleep 600', state: 'running' });
    c.job({ id: 'job1', kept: true, pgid: 4242 });
  });
  rt.sendMessage(t.id, { text: 'go' });
  await settle(rt);
  const cmd = () => store.state.work[t.id].find((e) => e.kind === 'command');
  assert.deepEqual([cmd().state, cmd().keptRunning], ['background', true]);
  const se = Object.values(store.state.sessions).find((s) => s.jobs?.length);
  await rt.stopJob(se.id, 'job1');
  assert.deepEqual([cmd().state, cmd().stoppedBy, !!cmd().leftRunning], ['stopped', 'you', false]);
});
