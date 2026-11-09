// Replaying recorded Claude Code turns into a ledger, for the Work tests.
import { readFileSync } from 'node:fs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { Ledger } from '../server/ledger.mjs';
import { Store } from '../server/store.mjs';

// Streams recorded from real Claude Code turns (claude 2.1.309, claude-haiku-5-5), with local paths removed.
export const fixture = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** Files in memory, in the shape server/ledger.mjs reads and writes them. */
export function memIo(initial = {}) {
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
export function fakeGit(table) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push(`${cwd} $ git ${args.join(' ')}`);
    for (const [pattern, answer] of table) if (pattern.test(`${cwd} ${args.join(' ')}`)) return { code: 0, stderr: '', ...answer };
    return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
  };
  return Object.assign(git, { calls });
}

/**
 * Replays a recorded turn into a ledger. The tools’ effects on the files are applied as the recording says they
 * happened. raced: each main-agent edit lands before Postbox reads the file, as when the tool wins the race; the
 * tool’s own record of the file (originalFile) must then set it right. edit: each recorded event, changed before it
 * plays.
 */
export async function replayLedger(name, { files = {}, git = fakeGit([]), raced = false, extra = {}, edit = (e) => e } = {}) {
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
  for (const e of fixture(name)) m.push(edit(e));
  await ledger.endTurn(turn, { status: 'done' });
  await ledger.idle();
  const entries = store.state.work.th_1;
  const of = (kind) => entries.filter((e) => e.kind === kind);
  return { store, ledger, io, entries, of, turn };
}

export const REC = [
  [/rev-parse --show-toplevel/, { stdout: '/workspace/rec\n' }],
  [/ls-files --error-unmatch -- notes\.txt/, { stdout: 'notes.txt\n' }],
  [/ls-files --error-unmatch/, { code: 1, stdout: '' }],
  [/show .*0e1af64/, { stdout: `${'a'.repeat(40)}\x1fLedger test\n\n1\t0\thello.md\n1\t1\tnotes.txt\n1\t0\tuntracked.txt\n` }],
  [/show .*15ae03c/, { stdout: `${'b'.repeat(40)}\x1fSecond\n\n1\t1\thello.md\n` }],
];
