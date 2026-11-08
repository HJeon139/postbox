// The big room’s work, opt in (`work: true` on seedBigRoom, #305, designs/305-archive-turns.md, “Context: what the
// state holds today”): each agent reply becomes the last reply of a turn of its agent, and the seed writes that turn’s
// work entries (`work.add`, in the shapes server/ledger.mjs writes them once a turn has ended) and the reply’s steps
// (`item.activity.steps`, as the runtime’s activity() leaves them), so the archive pass is measured on a room shaped
// like a real one before it changes any state. It draws on a random stream of its own, so the items are the room’s
// without it, plus each reply’s turn id and steps.
//
// The proportions are the 1 November 2026 run’s, on a copy of one real store (that design’s “Context” and I4), not
// this room’s, which nobody measured: 6,480 work entries over 930 turns, about 7 a turn with the turn’s own entry;
// 4,573 of them commands (71%), each about 430 bytes without its line and 700 more with it; the largest turn’s work
// 243 KB and the median’s 0.6 KB; 12,924 steps on 916 replies, about 14 a reply and 300 bytes a step; and the turns
// with an entry left open holding 0.24 MB of the 6.02 MB of work (4%).

/**
 * One cycle of TURN_SHAPES.length turns, turn k taking shape k mod the length. commands: how many it runs; reads and
 * edits: files it reads and changes; ship: its last four commands make a branch, a commit, a push and a pull request
 * (`gh pr create`); open: its first command is left in that state, I4’s open states; huge: its command lines are
 * heredocs every HUGE_EVERY cycles. Per cycle: 11 turns of 20 run no command, so the median turn is a turn entry and a
 * read (about 0.6 KB); 98 commands, 4.9 a turn; 8 reads and 8 changes; one ship; 138 entries, 6.9 a turn, 71%
 * commands, before the conversation’s file entries. One turn in 10 is open, on its smallest turns, for about 4% of the
 * work.
 */
const TURN_SHAPES = [
  { commands: 0, reads: 1 },
  { commands: 3, edits: 1 },
  { commands: 0 },
  { commands: 1, open: 'unknown' },
  { commands: 0, reads: 1 },
  { commands: 9, reads: 1, edits: 1 },
  { commands: 0 },
  { commands: 2, open: 'background' },
  { commands: 0, reads: 1 },
  { commands: 58, reads: 1, edits: 2, huge: true },
  { commands: 0 },
  { commands: 1, edits: 1 },
  { commands: 0, reads: 1 },
  { commands: 4, edits: 1 },
  { commands: 0 },
  { commands: 6, edits: 1, ship: true },
  { commands: 0, reads: 1 },
  { commands: 14, reads: 1, edits: 1 },
  { commands: 0 },
  { commands: 0 },
];
/** The huge turn’s lines are heredocs one cycle in this many, so the largest turn is about the 243 KB on record. */
const HUGE_EVERY = 5;
/** Steps that aren’t the ledger’s (thoughts, Postbox’s own tools): 6 a reply, 5 more when it ran commands, for ~14. */
const EXTRA_STEPS = { thoughts: 3, tools: 3, withCommands: { thoughts: 2, tools: 3 } };
/** The files the agents read and change, so a file’s entry is patched by each later turn that changes it. */
const FILES = ['packaging', 'changelog', 'ci', 'migration', 'deprecations', 'scan', 'notes', 'plan'].flatMap((w) => [`server/${w}.mjs`, `docs/${w}.md`]);
const WORDS = 'the release train freezes on the branch and tags once the scan and the changelog agree with the plan'.split(' ');
const TEMPLATES = [
  'npm test -- tests/{w}.test.mjs',
  'git status --short',
  'node tools/lint-copy.mjs',
  'grep -rn "{w}" server shared',
  'sed -n 1,120p server/{w}.mjs',
  'git diff --stat',
];
const POSTBOX_LABELS = ['Reading the conversation', 'Reading a message', 'Showing a block', 'Waking an agent'];
const CWD = '/work/release';

/** @typedef {{ rnd: () => number, threadId: string, sessions: Record<string, { sessionId: string }>, files: Map<string, any>, prs: number }} Ctx */

const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo));
const hex = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const toolUseId = (rnd) => `toolu_01${Array.from({ length: 22 }, () => pick(rnd, [...'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'])).join('')}`;
/** Words to about `n` characters. @param {() => number} rnd @param {number} n */
function prose(rnd, n) {
  let s = '';
  while (s.length < n) s += `${s ? ' ' : ''}${pick(rnd, WORDS)}`;
  return s;
}
const snap = (rnd) => ({ exists: true, size: between(rnd, 400, 40000), sha256: hex(rnd, 64), binary: false });

/** A command line: chained checks to a few hundred characters, or a heredoc of 3 to 5 KB in a huge turn. */
function commandLine(rnd, huge) {
  if (huge) return `cat > notes/${pick(rnd, WORDS)}.md <<'EOF'\n${prose(rnd, between(rnd, 3000, 5000))}\nEOF`;
  const target = between(rnd, 80, 700);
  let line = '';
  while (line.length < target) line += `${line ? ' && ' : ''}${pick(rnd, TEMPLATES).replace('{w}', pick(rnd, WORDS))}`;
  return line;
}

/**
 * One command entry as the ledger leaves it once its turn has ended (Ledger.toolUse, commandEnded, endTurn): done
 * with its exit and output, or left open: `unknown` with no result, or `background` kept running past the turn.
 * @param {Ctx} c  @param {any} base  @param {{ id: string, line: string, open?: string }} o
 */
function commandEntry(c, base, { id, line, open }) {
  const { rnd } = c;
  const ms = between(rnd, 50, 30000);
  const head = { ...base, kind: 'command', id, toolUseId: toolUseId(rnd), who: null, command: line, description: prose(rnd, between(rnd, 20, 60)) };
  const output = { sha256: hex(rnd, 64), size: between(rnd, 100, 8000) };
  if (open === 'unknown') return { ...head, background: false, startedAt: base.at, state: 'unknown', ms };
  if (open === 'background')
    return {
      ...head,
      background: true,
      startedAt: base.at,
      state: 'background',
      exit: null,
      ms,
      output,
      taskId: hex(rnd, 8),
      keptRunning: true,
      leftRunning: true,
    };
  return { ...head, background: false, startedAt: base.at, state: 'done', exit: 0, ms, output };
}

/** The four commands of a shipping turn, and what commandEnded records from each: branch, commit, push, pull request. */
function shipEntries(c, base, id) {
  const { rnd } = c;
  const branch = `release/${pick(rnd, WORDS)}-${hex(rnd, 4)}`;
  const message = `chore: ${prose(rnd, 40)}`;
  const pr = ++c.prs;
  const lines = [`git switch -c ${branch}`, `git commit -am "${message}"`, `git push -u origin ${branch}`, 'gh pr create --fill --base main'];
  const cmds = lines.map((line, n) => commandEntry(c, base, { id: `${id}_s${n}`, line }));
  const files = [{ path: pick(rnd, FILES), added: between(rnd, 1, 80), deleted: between(rnd, 0, 30), binary: false }];
  return [
    cmds[0],
    { ...base, kind: 'branch', id: `wb${id.slice(2)}`, commandId: cmds[0].id, name: branch, cwd: CWD },
    cmds[1],
    {
      ...base,
      kind: 'commit',
      id: `wk${id.slice(2)}`,
      commandId: cmds[1].id,
      sha: hex(rnd, 40),
      branch,
      cwd: CWD,
      message,
      files,
      added: files[0].added,
      deleted: files[0].deleted,
    },
    cmds[2],
    { ...base, kind: 'push', id: `wp${id.slice(2)}`, commandId: cmds[2].id, branch, remote: 'origin', refs: [branch], cwd: CWD },
    cmds[3],
    {
      ...base,
      kind: 'external',
      id: `wx${id.slice(2)}`,
      commandId: cmds[3].id,
      via: 'gh',
      what: 'gh pr create',
      command: lines[3],
      urls: [`https://github.com/example/release/pull/${pr}`],
      state: 'done',
    },
  ];
}

/**
 * A change to a file, as recordChange writes it: the conversation’s file entry the first time (no turn id: it is the
 * conversation’s), a patch of it each later time, and the turn’s change entry. @param {Ctx} c @param {any} base
 */
function changeEvents(c, base, id) {
  const { rnd } = c;
  const path = pick(rnd, FILES);
  const before = snap(rnd);
  const after = snap(rnd);
  const added = between(rnd, 1, 120);
  const deleted = between(rnd, 0, 40);
  const known = c.files.get(path);
  /** @type {Array<[string, any]>} */
  const events = [];
  const fileId = known?.id ?? `wf_${path.replace(/\W/g, '_')}`;
  if (!known) {
    const file = { kind: 'file', id: fileId, path: `${CWD}/${path}`, rel: path, outside: false, existed: true, tracked: true, before, after, added, deleted };
    const rest = {
      binary: false,
      uncounted: false,
      written: added,
      writtenDel: deleted,
      handles: [base.handle],
      lastHandle: base.handle,
      turns: [base.turnId],
    };
    c.files.set(path, { ...file, ...rest });
    events.push(['work.add', { ...file, ...rest, firstAt: base.at, lastAt: base.at, restored: null }]);
  } else {
    const patch = { after, added, deleted, binary: false, uncounted: false, written: known.written + added, writtenDel: known.writtenDel + deleted };
    const who = { handles: [...new Set([...known.handles, base.handle])], lastHandle: base.handle, turns: [...known.turns, base.turnId].slice(-200) };
    Object.assign(known, patch, who);
    events.push(['work.patch', { id: fileId, patch: { ...patch, ...who, lastAt: base.at, restored: null } }]);
  }
  const tools = between(rnd, 1, 4);
  events.push(['work.add', { ...base, kind: 'change', id, fileId, who: null, tools, before, after, added, deleted, binary: false, uncounted: false }]);
  return { events, label: `Edited ${path.split('/').pop()}` };
}

/** The steps that aren’t ledger entries: thoughts, as the stream mapper keeps them, and Postbox’s own tool calls. */
function extraSteps(rnd, ranCommands) {
  const more = ranCommands ? EXTRA_STEPS.withCommands : { thoughts: 0, tools: 0 };
  const thoughts = Array.from({ length: EXTRA_STEPS.thoughts + more.thoughts }, (_, n) => {
    const detail = prose(rnd, between(rnd, 200, 900));
    return { id: `thought-${n + 1}`, label: detail.slice(0, 120), state: 'done', ms: null, detail, kind: 'thought' };
  });
  const tools = Array.from({ length: EXTRA_STEPS.tools + more.tools }, () => ({
    id: toolUseId(rnd),
    label: pick(rnd, POSTBOX_LABELS),
    state: 'done',
    ms: between(rnd, 5, 400),
  }));
  return [thoughts[0], ...tools, ...thoughts.slice(1)];
}

/**
 * Turn k’s events, in the order the ledger writes them, and its reply’s steps.
 * @param {Ctx} c  @param {number} k  @param {any} item  the reply  @param {number} from  when the turn started
 */
function turnOf(c, k, item, from) {
  const { rnd } = c;
  const shape = TURN_SHAPES[k % TURN_SHAPES.length];
  const huge = Boolean(shape.huge) && Math.floor(k / TURN_SHAPES.length) % HUGE_EVERY === 0;
  const turnId = `turn_big${String(k).padStart(5, '0')}`;
  const tag = `_big${String(k).padStart(5, '0')}`;
  const plain = shape.ship ? shape.commands - 4 : shape.commands;
  const n = plain + (shape.ship ? 4 : 0) + (shape.reads ?? 0) + (shape.edits ?? 0);
  const at = (j) => from + Math.floor(((j + 1) * (item.at - from)) / (n + 2));
  const base = (j) => ({ turnId, threadId: c.threadId, sessionId: c.sessions[item.handle]?.sessionId ?? null, handle: item.handle, at: at(j) });
  /** @type {Array<[string, any]>} */
  const events = [];
  const steps = [];
  let j = 0;
  for (let r = 0; r < (shape.reads ?? 0); r++, j++) {
    const what = pick(rnd, FILES);
    const e = { ...base(j), kind: 'read', id: `wg${tag}_${r}`, toolUseId: toolUseId(rnd), who: null, tool: 'Read', what, where: null };
    events.push(['work.add', e]);
    steps.push({ id: e.toolUseId, label: `Read ${what.split('/').pop()}`, state: 'done', ms: between(rnd, 5, 200) });
  }
  for (let m = 0; m < plain; m++, j++) {
    const e = commandEntry(c, base(j), { id: `wc${tag}_${m}`, line: commandLine(rnd, huge), open: m === 0 ? shape.open : undefined });
    events.push(['work.add', e]);
    steps.push({ id: e.toolUseId, label: e.description, state: 'done', ms: e.ms, ...(e.state === 'background' ? { job: e.taskId } : {}) });
  }
  if (shape.ship) {
    for (const e of shipEntries(c, base(j), `wc${tag}`)) {
      events.push(['work.add', e]);
      if (e.kind === 'command') steps.push({ id: e.toolUseId, label: e.description, state: 'done', ms: e.ms });
    }
    j += 4;
  }
  for (let d = 0; d < (shape.edits ?? 0); d++, j++) {
    const change = changeEvents(c, base(j), `wd${tag}_${d}`);
    events.push(...change.events);
    steps.push({ id: toolUseId(rnd), label: change.label, state: 'done', ms: between(rnd, 5, 200) });
  }
  const allSteps = [...steps, ...extraSteps(rnd, shape.commands > 0)];
  const turn = turnEntry(rnd, {
    turnId,
    threadId: c.threadId,
    sessionId: base(0).sessionId,
    handle: item.handle,
    from,
    end: at(n),
    toolCalls: allSteps.length,
  });
  return { events: [['work.add', turn], ...events], steps: allSteps };
}

/** A turn’s own entry once it has ended: startTurn’s fields with endTurn’s patch over them. */
function turnEntry(rnd, { turnId, threadId, sessionId, handle, from, end, toolCalls }) {
  const input = between(rnd, 2000, 60000);
  const tokens = { input, output: between(rnd, 200, 8000), cacheRead: input * between(rnd, 2, 20), cacheWrite: between(rnd, 0, 20000) };
  const head = { kind: 'turn', id: turnId, turnId, threadId, sessionId, handle, startedAt: from, status: 'done', toolCalls };
  return { ...head, endedAt: end, ms: end - from, costUsd: Math.round(rnd() * 200) / 100, tokens };
}

/**
 * The room’s items with each agent reply made the last reply of a turn of its agent, and each turn’s events by the id
 * of the reply they come before. The work goes to threadId, the room’s conversation; sessions: each agent’s session.
 * @param {any[]} items  @param {{ threadId: string, sessions?: Record<string, { sessionId: string }>, rnd: () => number }} o
 */
export function roomWork(items, { threadId, sessions = {}, rnd }) {
  /** @type {Ctx} */
  const c = { rnd, threadId, sessions, files: new Map(), prs: 0 };
  /** @type {Map<string, Array<[string, any]>>} */
  const before = new Map();
  let k = 0;
  const out = items.map((it, i) => {
    if (it.kind !== 'agent') return it;
    const from = (items[i - 1]?.at ?? it.at - 60000) + 1;
    const turn = turnOf(c, k++, it, from);
    before.set(
      it.id,
      turn.events.map(([type, d]) => [type, { convId: threadId, ...(type === 'work.add' ? { entry: d } : d) }]),
    );
    return { ...it, turnId: turn.events[0][1].turnId, activity: { steps: turn.steps } };
  });
  return { items: out, before };
}
