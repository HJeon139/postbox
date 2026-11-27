// What a run spent on Claude Code, from the results its sessions report: the one backend that reports dollars.
//
// A result’s total_cost_usd is its Claude Code session’s running total, not the cost of that one call: a resumed
// session continues from the total its transcript saved, so its first result already carries the earlier turns
// (Claude Code’s published types, sdk.d.ts, on total_cost_usd: “read the latest result rather than summing across results”). Every
// recorded run shows it: each agent session’s totals only grow, turn after turn. Agents resume their session every
// turn, and the tester every step, so adding the totals counts every earlier turn again: the longresearch run of
// 24 October added up to $17.64 for its agents, whose two sessions ended at $1.37 and $0.57.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A session’s spend after one more result: the most it has reported. A crashed call’s zeroed result lowers nothing.
 * @param {number} spent  @param {any} result
 */
export const sessionTotal = (spent, result) => Math.max(spent, Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : 0);

/**
 * Each agent turn’s cost, in the order the turns started: its result’s total less the most its session had reported
 * before. A forked session (a topic thread) starts from its parent’s total, which counts here as the fork’s first
 * turn: more than it spent, never less.
 * @param {{ handle?: string, started?: number, events: any[] }[]} streams  from readStreams (tools/uat/run-files.mjs)
 * @returns {{ handle: string|undefined, session: string|null, usd: number }[]}
 */
export function turnCosts(streams) {
  /** @type {Map<string, number>} */
  const most = new Map();
  const out = [];
  for (const s of [...(streams ?? [])].sort((a, b) => (a.started ?? 0) - (b.started ?? 0)))
    for (const e of s.events ?? []) {
      if (e?.type !== 'result' || !Number.isFinite(e.total_cost_usd)) continue;
      const session = typeof e.session_id === 'string' ? e.session_id : null;
      const before = session ? (most.get(session) ?? 0) : 0;
      out.push({ handle: s.handle, session, usd: Math.max(0, e.total_cost_usd - before) });
      if (session) most.set(session, sessionTotal(before, e));
    }
  return out;
}

/** What the agents’ turns cost, together. @param {{ events: any[] }[]} streams */
export const agentsSpent = (streams) => turnCosts(streams).reduce((a, t) => a + t.usd, 0);

/**
 * The run’s streams that report dollars: Claude Code’s.
 * @param {{ streams?: any[] }} facts
 */
export const dollarStreams = (facts) => facts.streams ?? [];

/** The folders those streams are recorded in, for streamResults. @param {{ streams: string }} paths */
export const dollarFolders = (paths) => [paths.streams];

/**
 * The tokens Codex used over a run’s turns, in and out. Codex reports no cost. Its count runs on for a thread from
 * turn to turn, so each thread’s largest total is taken, and the threads are added up. The largest, not the last
 * read: the streams come in the order their files are read, which isn’t the order the turns ran.
 * @param {{ events: any[] }[]} streams  the run’s Codex streams
 */
export function codexTokens(streams) {
  /** @type {Map<string, number>} */
  const most = new Map();
  for (const { events } of streams ?? [])
    for (const e of events ?? []) {
      const total = e?.method === 'thread/tokenUsage/updated' ? e.params?.tokenUsage?.total : null;
      if (!total) continue;
      const thread = String(e.params.threadId);
      most.set(thread, Math.max(most.get(thread) ?? 0, (total.inputTokens ?? 0) + (total.outputTokens ?? 0)));
    }
  return [...most.values()].reduce((a, n) => a + n, 0);
}

/**
 * The harnesses a run had turns on that report no cost in dollars, so the agents’ cost a run states is Claude Code’s
 * alone: a run’s budget (--max-cost) doesn’t count their turns either.
 * @param {{ codexStreams?: any[], kiroStreams?: any[], agyStreams?: any[] }} facts
 * @returns {string[]}
 */
export function uncosted(facts) {
  const ran = { Codex: facts.codexStreams, Kiro: facts.kiroStreams, Antigravity: facts.agyStreams };
  return Object.entries(ran)
    .filter(([, streams]) => streams?.length)
    .map(([name]) => name);
}

/**
 * A reader of the turns’ streams in `folders`, cut to their result events, for a budget that reads them every few
 * seconds: a file whose size hasn’t changed since it was last read isn’t read again. Each call returns every stream
 * in every folder, as readStreams (tools/uat/run-files.mjs) does, with only its results.
 * @param {...string} folders  the folders of the backends that report dollars: streams/
 * @returns {() => { handle: string, started: number|undefined, events: any[] }[]}
 */
export function streamResults(...folders) {
  /** @type {Map<string, { size: number, stream: { handle: string, started: number|undefined, events: any[] } }>} */
  const seen = new Map();
  /** @param {string} file  @param {string} name */
  const read = (file, name) => {
    const { size } = statSync(file);
    const hit = seen.get(file);
    if (hit?.size === size) return hit.stream;
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"type":"result"'))
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    const stream = { handle: name.replace(/^\d+-/, '').replace(/\.jsonl$/, ''), started: Number(/^(\d+)-/.exec(name)?.[1]) || undefined, events };
    seen.set(file, { size, stream });
    return stream;
  };
  return () =>
    folders
      .filter((folder) => existsSync(folder))
      .flatMap((folder) =>
        readdirSync(folder)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => read(join(folder, f), f)),
      );
}
