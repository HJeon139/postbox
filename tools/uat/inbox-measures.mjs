// What the inbox’s build must show (designs/rooms-at-scale.md, “What the build must show”), counted from a finished
// UAT run’s folder: its event log, each agent’s recorded streams and its Claude Code transcripts. It runs no agent.
// Compare runs on `main` with runs on the branch:
//   node tools/uat/inbox-measures.mjs --main <run folder>… --branch <run folder>…
// Each measure is a function of plain records, so tests/uat-inbox-measures.test.mjs holds them without a run.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMentions } from '../../shared/text.mjs';
import { filesIn, jsonLines, turnsIn } from './run-turns.mjs';

/** The reads an agent makes to catch up, which the turn’s input is meant to make unnecessary. */
const CATCH_UP_READS = new Set(['read_message', 'read_conversation']);
/** How long a reply can be and still be only an acknowledgment. */
const ACK_CHARS = 200;

/**
 * The run’s items, oldest first, with their final text: an agent’s reply is added empty and filled as it streams.
 * @param {any[]} events  the event log’s lines
 */
export function itemsOf(events) {
  /** @type {Map<string, any>} */
  const items = new Map();
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'item.add' && d.item) items.set(d.item.id, { ...d.item, threadId: d.threadId, text: d.item.text ?? '' });
    const it = items.get(d.id);
    if (e.type === 'item.text' && it) it.text += d.text ?? '';
    if (e.type === 'item.patch' && it) Object.assign(it, d.patch ?? {});
  }
  return [...items.values()];
}

/**
 * The first reply of each turn another agent’s message started. A turn can post several items, and is one wake.
 * @param {any[]} items
 */
function wokenReplies(items) {
  const seen = new Set();
  return items.filter((i) => i.kind === 'agent' && i.woke?.by && !seen.has(i.turnId) && seen.add(i.turnId));
}

/** The handles of the run’s agents, from its replies. */
const handlesOf = (/** @type {any[]} */ items) => [...new Set(items.filter((i) => i.kind === 'agent' && i.handle).map((i) => i.handle))];

/**
 * Messages crossed: a reply posted after a newer message to its agent that the reply’s turn didn’t hold. A message
 * to the agent is one that @-mentions it; the turn didn’t hold it when it was posted after the turn started.
 * @param {any[]} items @param {{ handle: string, started: number }[]} turns
 */
export function crossed(items, turns) {
  const handles = handlesOf(items);
  const replies = items.filter((i) => i.kind === 'agent' && Number.isFinite(i.at));
  return replies.filter((reply) => {
    const turn = turns.filter((t) => t.handle === reply.handle && t.started <= reply.at).at(-1);
    if (!turn) return false;
    return items.some(
      (m) => m.id !== reply.id && m.handle !== reply.handle && m.at > turn.started && m.at < reply.at && parseMentions(m.text, handles).includes(reply.handle),
    );
  }).length;
}

/**
 * Wakes that found nothing to do: a turn another agent’s message started, which called no tool and whose reply is
 * short enough to be only an acknowledgment.
 * @param {any[]} items @param {{ turnId?: string, tools: string[] }[]} turns
 */
export function idleWakes(items, turns) {
  const tools = new Map(turns.map((t) => [t.turnId, t.tools]));
  const said = (/** @type {string} */ turnId) =>
    items
      .filter((i) => i.kind === 'agent' && i.turnId === turnId)
      .map((i) => i.text.trim())
      .join(' ');
  return wokenReplies(items).filter((i) => !(tools.get(i.turnId) ?? []).length && said(i.turnId).length <= ACK_CHARS).length;
}

/**
 * A hand-off posted twice: a turn that called wake_agent and whose reply also @-mentions an agent.
 * @param {any[]} items @param {{ turnId?: string, tools: string[] }[]} turns
 */
export function doubledHandOffs(items, turns) {
  const handles = handlesOf(items);
  const woke = new Set(turns.filter((t) => t.tools.includes('wake_agent')).map((t) => t.turnId));
  return items.filter((i) => i.kind === 'agent' && woke.has(i.turnId) && parseMentions(i.text, handles).some((h) => h !== i.handle)).length;
}

/**
 * Wakes by a copied line: a woken reply whose waking message names its agent only inside a line copied from the
 * conversation. Zero on a branch with #1370’s fix; on `main` it counts what the fix removes.
 * @param {any[]} items
 */
export function copyWakes(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const isCopy = (/** @type {string} */ id, /** @type {string} */ said) => {
    const words = said.replace(/^@[\w-]+[^:]*:\s*/, '').trim();
    return Boolean(words) && String(byId.get(id)?.text ?? '').includes(words);
  };
  return wokenReplies(items).filter((reply) => {
    const waking = items.filter((m) => m.kind === 'agent' && m.handle === reply.woke.by && m.at <= reply.at && m.id !== reply.id).at(-1);
    if (!waking) return false;
    return parseMentions(waking.text, [reply.handle]).length > 0 && parseMentions(waking.text, [reply.handle], isCopy).length === 0;
  }).length;
}

/**
 * Reads after a wake: in each turn another agent’s message started, the read_message and read_conversation calls
 * before its first other action.
 * @param {any[]} items @param {{ turnId?: string, tools: string[] }[]} turns
 * @returns {number[]}  one count per woken turn
 */
export function readsAfterWake(items, turns) {
  const woken = new Set(wokenReplies(items).map((i) => i.turnId));
  return turns
    .filter((t) => woken.has(t.turnId))
    .map((t) => {
      const other = t.tools.findIndex((name) => !CATCH_UP_READS.has(name));
      return other < 0 ? t.tools.length : other;
    });
}

/**
 * Entries waiting in another thread when a turn starts, from the event log’s entry events (server/delivery.mjs): once
 * a turn has taken its entries, how many of that agent’s entries still wait in a thread other than the one taken. A
 * notice rides a take whatever its thread, so it is neither the turn’s thread nor waiting elsewhere. A run on `main`
 * before the inbox has no entry events, and gives no counts.
 * @param {any[]} events
 * @returns {number[]}  one count per turn that took an entry other than a notice
 */
export function waitingElsewhere(events) {
  /** @type {Map<string, any>} */
  const entries = new Map();
  const counts = [];
  /** @type {string | null} */
  let taking = null;
  const seen = new Set();
  const close = () => {
    const all = [...entries.values()];
    const lead = all.find((x) => x.takenBy === taking && x.source !== 'notice');
    const elsewhere = (/** @type {any} */ x) =>
      x.sessionId === lead.sessionId && x.state === 'waiting' && x.source !== 'notice' && x.threadId !== lead.threadId;
    if (lead) counts.push(all.filter(elsewhere).length);
    taking = null;
  };
  for (const e of events) {
    const d = e.data ?? {};
    const entry = e.type === 'entry.patch' ? entries.get(d.id) : null;
    const turn = entry && d.patch?.state === 'taken' ? d.patch.takenBy : null;
    // A turn’s take is a run of patches naming it; anything else ends the run, and the count is made then.
    if (taking && turn !== taking) close();
    if (e.type === 'entry.add' && d.entry) entries.set(d.entry.id, { ...d.entry, sessionId: d.sessionId });
    if (entry) Object.assign(entry, d.patch ?? {});
    if (turn && !seen.has(turn)) {
      seen.add(turn);
      taking = turn;
    }
  }
  if (taking) close();
  return counts;
}

/**
 * Postbox’s input per turn, in tokens as characters divided by four: each prompt Postbox gave a Claude Code session,
 * from its transcript. A tool’s result is the agent’s own reading, not Postbox’s input, and isn’t counted.
 * @param {any[]} transcript  a Claude Code transcript’s lines
 * @returns {number[]}  one size per prompt
 */
export function promptTokens(transcript) {
  const sizes = [];
  for (const line of transcript) {
    const content = line?.type === 'user' ? line.message?.content : null;
    if (typeof content === 'string') sizes.push(content.length);
    else if (Array.isArray(content) && !content.some((c) => c?.type === 'tool_result'))
      sizes.push(content.reduce((n, c) => n + String(c?.text ?? '').length, 0));
  }
  return sizes.map((chars) => Math.round(chars / 4));
}

/** Gives each turn the id Postbox knows it by: that of the agent’s first reply at or after the turn started. */
function withTurnIds(/** @type {any[]} */ turns, /** @type {any[]} */ items) {
  return turns.map((t, i) => {
    const next = turns.find((x, j) => j > i && x.handle === t.handle)?.started ?? Number.POSITIVE_INFINITY;
    const reply = items.find((it) => it.kind === 'agent' && it.handle === t.handle && it.at >= t.started && it.at < next);
    return { ...t, turnId: reply?.turnId };
  });
}

const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * One run’s measures.
 * @param {string} dir  the run’s folder
 */
export function measure(dir) {
  const events = filesIn(path.join(dir, 'data'), /^events-\d+\.jsonl$/).flatMap(jsonLines);
  const items = itemsOf(events);
  const turns = withTurnIds(turnsIn(dir), items);
  const prompts = filesIn(path.join(dir, 'transcripts'), /\.jsonl$/).flatMap((f) => promptTokens(jsonLines(f)));
  const reported = (/** @type {'requests'|'input'} */ key) => turns.map((t) => t[key]).filter((v) => v !== null);
  return {
    turns: turns.length,
    crossed: crossed(items, turns),
    idleWakes: idleWakes(items, turns),
    doubledHandOffs: doubledHandOffs(items, turns),
    copyWakes: copyWakes(items),
    requestsPerTurn: mean(reported('requests')),
    readsAfterWake: mean(readsAfterWake(items, turns)),
    promptTokensPerTurn: mean(prompts),
    inputTokensPerTurn: mean(reported('input')),
    waitingElsewhere: mean(waitingElsewhere(events)),
  };
}

/** What each measure is called, and what passes, as the design’s table has them. */
const ROWS = [
  ['crossed', 'Messages crossed', 'fewer than main'],
  ['idleWakes', 'Wakes that found nothing to do', 'no more than main'],
  ['doubledHandOffs', 'A hand-off posted twice', 'none'],
  ['copyWakes', 'Wakes by a copied line', 'none'],
  ['requestsPerTurn', 'Model requests per turn', 'no more than main'],
  ['readsAfterWake', 'Reads after a wake, per woken turn', 'fewer than main'],
  ['promptTokensPerTurn', 'Postbox’s input per turn, Claude Code, tokens', 'no more than main'],
  ['inputTokensPerTurn', 'Input tokens per turn, as reported', 'reported'],
  ['waitingElsewhere', 'Entries waiting in another thread at a turn’s start', 'reported'],
];

/**
 * A measure across one side’s runs: its mean and range, or “not recorded” when no run has it.
 * @param {any[]} runs @param {string} key
 */
export function across(runs, key) {
  const values = runs.map((r) => r[key]).filter((v) => v !== null);
  if (!values.length) return 'not recorded';
  const round = (/** @type {number} */ n) => {
    if (Math.abs(n) >= 100) return Math.round(n).toLocaleString('en-US');
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  const range = values.length > 1 ? ` (${round(Math.min(...values))} to ${round(Math.max(...values))})` : '';
  return `${round(/** @type {number} */ (mean(values)))}${range}`;
}

/** The table for two sides’ runs, as Markdown. */
export function table(/** @type {any[]} */ main, /** @type {any[]} */ branch) {
  const head = `| Measure | main, ${main.length} ${main.length === 1 ? 'run' : 'runs'} | branch, ${branch.length} ${branch.length === 1 ? 'run' : 'runs'} | What passes |\n|---|---|---|---|`;
  return [head, ...ROWS.map(([key, name, passes]) => `| ${name} | ${across(main, key)} | ${across(branch, key)} | ${passes} |`)].join('\n');
}

/** The run folders after a flag, up to the next flag. */
function foldersAfter(/** @type {string[]} */ argv, /** @type {string} */ flag) {
  const at = argv.indexOf(flag);
  if (at < 0) return [];
  const rest = argv.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const main = foldersAfter(process.argv, '--main');
  const branch = foldersAfter(process.argv, '--branch');
  if (!main.length && !branch.length) {
    console.error('Give the runs to compare: node tools/uat/inbox-measures.mjs --main <run folder>… --branch <run folder>…');
    process.exit(2);
  }
  console.log(table(main.map(measure), branch.map(measure)));
}
