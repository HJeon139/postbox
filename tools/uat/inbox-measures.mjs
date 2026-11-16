// What the inbox’s build must show (designs/rooms-at-scale.md, “What the build must show”), counted from a finished
// UAT run’s folder: its event log, each agent’s recorded streams and its Claude Code transcripts. It runs no agent.
// Compare runs on `main` with runs on the branch:
//   node tools/uat/inbox-measures.mjs --main <run folder>… --branch <run folder>…
// Each measure is a function of plain records, so tests/uat-inbox-measures.test.mjs holds them without a run.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMentions } from '../../shared/text.mjs';
import { harnessTable, table } from './inbox-tables.mjs';
import { waitingElsewhere } from './run-entries.mjs';
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
  const doubled = items.filter((i) => i.kind === 'agent' && woke.has(i.turnId) && parseMentions(i.text, handles).some((h) => h !== i.handle));
  // A turn can post several items, and is one hand-off.
  return new Set(doubled.map((i) => i.turnId)).size;
}

/**
 * Wakes by a copied line: a woken reply whose waking turn names its agent only inside a line copied from the
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
    const last = items.filter((m) => m.kind === 'agent' && m.handle === reply.woke.by && m.at <= reply.at && m.id !== reply.id).at(-1);
    if (!last) return false;
    // Everything the waking turn said: a turn can post several items, and a mention in any of them wakes.
    const said = items
      .filter((m) => m.kind === 'agent' && m.turnId === last.turnId)
      .map((m) => m.text)
      .join('\n');
    return parseMentions(said, [reply.handle]).length > 0 && parseMentions(said, [reply.handle], isCopy).length === 0;
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
 * A run’s turns added up by harness: how many, the input tokens and model requests they report, and their tool calls.
 * A harness that reports no tokens or requests has null there, not zero.
 * @param {{ harness: string, requests: number|null, input: number|null, tools: string[] }[]} turns
 */
export function byHarness(turns) {
  /** @type {Record<string, { turns: number, input: number|null, requests: number|null, toolCalls: number }>} */
  const sums = {};
  const plus = (/** @type {number|null} */ sum, /** @type {number|null} */ n) => (n === null ? sum : (sum ?? 0) + n);
  for (const t of turns) {
    const h = (sums[t.harness] ??= { turns: 0, input: null, requests: null, toolCalls: 0 });
    h.turns++;
    h.input = plus(h.input, t.input);
    h.requests = plus(h.requests, t.requests);
    h.toolCalls += t.tools.length;
  }
  return sums;
}

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
    harnesses: byHarness(turns),
  };
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
  const [before, after] = [main.map(measure), branch.map(measure)];
  console.log(`${table(before, after)}\n\n${harnessTable(before, after)}`);
}
