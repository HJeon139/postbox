// The broker’s state (#120): one daemon’s calls, prompts, expiries, shims, snapshots and Codex watches, with what the
// daemon passed in. createBroker (broker.mjs) makes it, and the broker-*.mjs modules take it first, as `b`.

import { HOST_DEFAULTS, REMOTE_LIMITS } from '../../../shared/remote-protocol.mjs';

/** The protocol’s words for a call the harness gave up on: prompt-expired’s reason, and the shim’s message. */
export const CANCELED = /** @type {const} */ ('canceled');
export const CANCELED_MSG = 'permission-canceled';

/** What the laptop says to a call from a stopped turn (server/mcp.mjs), word for word. */
export const STOPPED_TEXT = 'This call came from an agent turn that was stopped or has ended, so Postbox didn’t run it.';
/** The shim’s result for a call that’s queued: the agent already has its answer, so this only settles the shim’s copy. */
export const QUEUED_TEXT = 'Queued for Postbox.';
/** How often a held Codex turn’s logs are read for approval requests and their answers. */
export const CODEX_POLL_MS = 1000;

export const count = (n) => n.toLocaleString('en-US');
/** A call’s or prompt’s identity: (turn, id). @param {string} turn @param {string} id */
export const key = (turn, id) => `${turn} ${id}`;

/**
 * @typedef {{ turn: string, id: string, name: string, route: 'queue' | 'ask', args: Record<string, any> | null, replied: boolean,
 *   result?: { ok: boolean, text: string }, saved?: Promise<string>, replying?: Promise<string>, bytes?: number }} Tool
 *   saved: settles once the call is written down, with '' or why it couldn’t be (a prompt’s likewise); replying: a
 *   reply being written down, likewise (a prompt’s answering); bytes: its tool message’s encoded size, while it waits
 * @typedef {{ turn: string, id: string, request: Record<string, any>, answer: Record<string, any> | null, over: boolean,
 *   at: number, replayed?: boolean, saved?: Promise<string>, answering?: Promise<string> }} Prompt
 *   at: when it was asked; replayed: read back from prompts.jsonl at start, and no shim has sent it again since
 * @typedef {{ turn: string, id: string, at: number, reason: 'expired' | typeof CANCELED }} Expiry
 * @typedef {{ turn: string | null, closed: boolean, send: (type: string, body: Record<string, unknown>) => void }} ShimConn
 * @typedef {{ pos: number, rest: Buffer, skipping: boolean }} LogPos
 * @typedef {{ rpcId: unknown, method: string, id: string | null, seen: number }} CodexRequest
 * @typedef {{ turn: string, out: LogPos, in: LogPos, requests: Map<string, CodexRequest>, pending: Map<string, CodexRequest>,
 *   answering: Map<string, 'write' | 'decline'>, settled: Set<string>, declined: Set<string>, tried: Set<string>,
 *   timer: any, busy: boolean }} CodexWatch
 *   by JSON-RPC ID as JSON: requests, every approval request seen; pending, those still unanswered; answering, a
 *   Postbox write or the daemon’s decline on its way to the held stdin; settled, answered in in.jsonl or by a line
 *   that went; declined, by the daemon; tried, those Postbox wrote (or tried to) through this daemon
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void }} Timers
 * @typedef {import('./broker-reading.mjs').Snapshot} Snapshot
 * @typedef {{ paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>, now?: () => number, timers?: Timers,
 *   log?: (line: string) => void, settings?: () => Record<string, any>,
 *   toPostbox: (type: string, body: Record<string, unknown>) => boolean, attached: () => boolean,
 *   interrupted?: (turn: string) => boolean, writeStdin?: (turn: string, line: string) => Promise<unknown>, codexPollMs?: number,
 *   queueLimits?: { calls: number, bytes: number, recordBytes: number } }} BrokerOptions
 *   toPostbox: sends to the attached Postbox, false if none is; interrupted: the daemon found the turn’s runner isn’t
 *   the one runner.json names; writeStdin: one line for a turn’s held stdin, through its runner
 * @typedef {ReturnType<typeof brokerState>} Broker
 */

/**
 * The broker’s state, with the daemon’s options and their defaults. Everything it needs from the daemon is passed in,
 * so tests drive it without one.
 * @param {BrokerOptions} o
 */
export function brokerState({
  paths: p,
  now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (t) => clearTimeout(t) },
  log = () => {},
  settings = () => HOST_DEFAULTS,
  toPostbox,
  attached,
  interrupted = () => false,
  writeStdin = async () => {
    throw new Error('this daemon can’t write to a held stdin');
  },
  codexPollMs = CODEX_POLL_MS,
  queueLimits = { calls: REMOTE_LIMITS.waitingCalls, bytes: REMOTE_LIMITS.waitingCallBytes, recordBytes: REMOTE_LIMITS.callRecordBytes },
}) {
  return {
    queueLimits,
    p,
    now,
    timers,
    log,
    settings,
    toPostbox,
    attached,
    interrupted,
    writeStdin,
    codexPollMs,
    /** @type {Map<string, Tool>} every call seen, by (turn, id); a replied one keeps no args */
    tools: new Map(),
    /** @type {Map<string, Promise<void>>} each turn’s call being admitted (broker-tools.mjs’s admit) */
    admitting: new Map(),
    /** @type {Map<string, Prompt>} */
    prompts: new Map(),
    /** @type {Map<string, Expiry>} prompt-expired not yet sent to Postbox */
    expiries: new Map(),
    /** @type {Set<string>} Turns Stop was sent for: their shims are refused from then on. */
    stopping: new Set(),
    /** @type {Map<string, Set<ShimConn>>} the shims connected, by turn */
    shims: new Map(),
    /** @type {Map<string, Snapshot>} */
    pendingSnapshots: new Map(),
    /** @type {Map<string, Snapshot>} */
    cachedSnapshots: new Map(),
    /** @type {Map<string, CodexWatch>} */
    watches: new Map(),
    /** @type {Map<string, number>} Codex requests first seen (from prompts.jsonl), by (turn, codex ID). */
    codexSeen: new Map(),
    /** @type {Set<string>} Codex requests Postbox has heard about from prompts.jsonl, its own answer or the expiry, by (turn, codex ID). */
    codexHeard: new Set(),
    /** @type {Set<string>} Prompts that ended without their record: never answered or sent again, by (turn, id). */
    unrecordedEnds: new Set(),
    /** @type {Set<any>} The timers that end prompts read back at start that no shim sent again. */
    orphanTimers: new Set(),
    /** @type {Map<string, Promise<void>>} appends in order, per file */
    appends: new Map(),
    ids: 0,
    closed: false,
  };
}

/** @param {Broker} b @param {string} turn @param {string} type @param {Record<string, unknown>} body */
export function toShims(b, turn, type, body) {
  for (const s of b.shims.get(turn) ?? []) s.send(type, body);
}
