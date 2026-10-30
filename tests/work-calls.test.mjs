import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';
import { beforePatch, unwrapShell } from '../server/adapters/work-calls.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';

// Turns recorded from real agents (#545), with local paths removed: Codex 0.164.0 (gpt-6-luna) and Antigravity CLI
// 1.4.10 (gemini-3.8-flash-low), each asked to edit calc.py, write a new file and run `git status --short`.
const fixture = (path) =>
  readFileSync(new URL(`fixtures/${path}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const ADD_MINUS = 'def add(a, b):\n    return a - b\n';
const ADD_PLUS = 'def add(a, b):\n    return a + b\n';

/** Files in memory, in the shape server/ledger.mjs reads them. */
function memIo(initial) {
  const fs = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const read = (p) => (fs.has(p) ? { exists: true, size: fs.get(p).length, bytes: Buffer.from(fs.get(p)) } : { exists: false });
  return {
    fs,
    text: (p) => fs.get(p)?.toString('utf8') ?? null,
    readNow: read,
    read: async (p) => read(p),
    readTail: async (p) => ({ bytes: fs.get(p) ?? Buffer.alloc(0), cut: false }),
    writeAtomic: async (p, b) => {
      fs.set(p, Buffer.from(b));
    },
    remove: async (p) => {
      fs.delete(p);
    },
  };
}

/** A ledger on one turn, and a turn context that hands it the mapper’s tool calls, as the runtime does. */
function ledgerTurn(io) {
  const store = new Store(null);
  let t = 0;
  // git isn’t there: every file is untracked, which these tests don’t look at.
  const git = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const ledger = new Ledger({ store, io, git, home: '/home/me', now: () => (t += 100) });
  store.emit('thread', { id: 'th_1', kind: 'thread', projectId: 'p1', members: [] });
  const turn = { id: 'turn_1', threadId: 'th_1', startedAt: 0 };
  ledger.startTurn(turn, { se: { id: 'se_1', handle: 'dev' }, folder: '/work/project', projectFolder: '/work/project' });
  const ctx = {
    state: {},
    persona: { model: 'gpt-6-luna' },
    text() {},
    activity() {},
    status() {},
    reported() {},
    checkpoint() {},
    toolUse: (u) => ledger.toolUse(turn, u),
    toolResult: (r) => ledger.toolResult(turn, r),
  };
  const done = async () => {
    await ledger.endTurn(turn, { status: 'done' });
    await ledger.idle();
    const entries = store.state.work.th_1;
    return { ledger, of: (kind) => entries.filter((e) => e.kind === kind) };
  };
  return { ctx, done };
}

/** Replays the Codex turn. Its writes land as its fileChange completes, or, raced, before Postbox hears it started. */
async function replayCodex({ raced }) {
  const io = memIo({ '/work/project/calc.py': ADD_MINUS });
  const { ctx, done } = ledgerTurn(io);
  // What each file holds after the change, as the recording’s turn/diff/updated says.
  const after = { '/work/project/calc.py': ADD_PLUS, '/work/project/NOTES.md': 'Fixed add.\n' };
  const m = createCodexMapper(ctx, { read: io.text });
  for (const e of fixture('codex-app-server/ledger-edits')) {
    const item = e.params?.item;
    if (item?.type === 'fileChange' && e.method === (raced ? 'item/started' : 'item/completed'))
      for (const c of item.changes) io.fs.set(c.path, Buffer.from(after[c.path]));
    m.push(e);
  }
  return done();
}

test('a Codex turn’s file changes reach Work with their lines, even when Codex writes before Postbox reads the file', async () => {
  for (const raced of [false, true]) {
    const { of, ledger } = await replayCodex({ raced });
    const files = Object.fromEntries(of('file').map((f) => [f.rel, f]));
    assert.deepEqual(Object.keys(files).sort(), ['NOTES.md', 'calc.py'], `raced: ${raced}`);
    assert.deepEqual([files['calc.py'].added, files['calc.py'].deleted, files['calc.py'].existed], [1, 1, true], `raced: ${raced}`);
    assert.deepEqual([files['NOTES.md'].added, files['NOTES.md'].deleted, files['NOTES.md'].existed], [1, 0, false], `raced: ${raced}`);
    const diff = await ledger.fileDiff('th_1', files['calc.py'].id);
    assert.deepEqual(
      diff.rows.filter((r) => r.kind !== 'same').map((r) => `${r.kind}:${r.t}`),
      ['del:    return a - b', 'add:    return a + b'],
      `raced: ${raced}: the copy from before is the file before the change`,
    );
  }
});

test('a Codex turn’s commands reach Work as the agent wrote them, without the shell around them, with their output', async () => {
  const { of, ledger } = await replayCodex({ raced: false });
  const cmds = of('command');
  assert.deepEqual(
    cmds.map((c) => [c.command, c.state, c.exit]),
    [
      ["pwd && rg --files -g 'calc.py' -g 'NOTES.md' -g 'AGENTS.md' && git status --short", 'done', 0],
      ['cat calc.py && git status --short', 'done', 0],
      ['git status --short', 'done', 0],
    ],
  );
  assert.equal(await ledger.output('th_1', cmds[2].id), ' M calc.py\n?? NOTES.md\n');
});

test('an Antigravity turn’s edits, its new file, its read and its command reach Work', async () => {
  const io = memIo({ '/work/project/calc.py': ADD_PLUS });
  const { ctx, done } = ledgerTurn(io);
  // What the files hold when each step is done, as the agent left them.
  const after = {
    edit_file: ['/work/project/calc.py', `${ADD_PLUS}\n\ndef sub(a, b):\n    return a - b\n`],
    write_file: ['/work/project/TODO.md', 'Add tests.\n'],
  };
  const m = createAgyMapper(ctx, { now: () => 1000 });
  for (const e of fixture('antigravity-cli/ledger-edits')) {
    const s = e.step_update;
    if (s?.step_type === 'tool' && s.state === 'DONE' && after[s.tool_name]) io.fs.set(...after[s.tool_name]);
    m.push(e);
  }
  const { of, ledger } = await done();
  const files = Object.fromEntries(of('file').map((f) => [f.rel, f]));
  assert.deepEqual(Object.keys(files).sort(), ['TODO.md', 'calc.py']);
  assert.deepEqual([files['calc.py'].added, files['calc.py'].deleted, files['calc.py'].existed], [4, 0, true]);
  assert.deepEqual([files['TODO.md'].added, files['TODO.md'].existed], [1, false]);
  const cmds = of('command');
  assert.deepEqual(
    cmds.map((c) => [c.command, c.state, c.exit]),
    [['git status --short', 'done', 0]],
  );
  assert.equal(await ledger.output('th_1', cmds[0].id), ' M calc.py\n?? NOTES.md\n?? TODO.md\n', 'the output without agy’s exit line, with \\n line ends');
  assert.deepEqual(
    of('read').map((r) => [r.tool, r.what]),
    [['Read', 'calc.py']],
  );
});

test('a patch whose file has changed again since gives no copy from before, rather than a wrong one', () => {
  const change = fixture('codex-app-server/ledger-edits').find((e) => e.method === 'item/completed' && e.params.item.type === 'fileChange').params.item
    .changes[1];
  assert.equal(beforePatch(ADD_PLUS, change.diff), ADD_MINUS);
  assert.equal(beforePatch('def add(a, b):\n    return b + a\n', change.diff), null);
});

test('a command Codex wraps in a login shell is shown as the agent wrote it, in either quoting', () => {
  const commands = fixture('codex-app-server/ledger-edits')
    .filter((e) => e.method === 'item/started' && e.params.item.type === 'commandExecution')
    .map((e) => [e.params.item.command, e.params.item.commandActions[0].command]);
  assert.equal(commands.length, 3);
  for (const [ran, asked] of commands) assert.equal(unwrapShell(ran), asked);
  assert.equal(unwrapShell('git status'), 'git status', 'a command with no wrapper is kept as it is');
});
