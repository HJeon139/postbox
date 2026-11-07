// The broker’s state (#120): one daemon’s calls, prompts, expiries, shims, snapshots and Codex watches, with what the
// daemon passed in. createBroker (broker.mjs) makes it, and the broker-*.mjs modules take it first, as `b`.

import { promises as fsp } from 'node:fs';
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
 * @typedef {{ turn: string, id: string, name: string, route: 'queue' | 'ask' | 'read', args: Record<string, any> | null, replied: boolean,
 *   owner?: string | null, result?: { ok: boolean, text: string }, saved?: Promise<string>, replying?: Promise<string>, offline?: boolean,
 *   bytes?: number, arrived?: number, timer?: any }} Tool
 *   owner: the calling shim’s ShimConn owner, the only one its result goes to (#908), null as a prompt’s is, and
 *   undefined for a record an older daemon wrote, which the first shim to send it again takes; saved: settles once the call is written down, with ''
 *   or why it couldn’t be (a prompt’s likewise); replying: a reply being written down, likewise (a prompt’s
 *   answering); bytes: its tool message’s encoded size, while it waits
 * @typedef {{ turn: string, id: string, entry: string, request: Record<string, any>, answer: Record<string, any> | null,
 *   over: boolean, at: number, owner?: string | null, asked: Set<ShimConn>, replayed?: boolean, saved?: Promise<string>,
 *   answering?: Promise<string> }} Prompt
 *   entry: the daemon’s own ID for the prompt’s record (broker-prompts.mjs); at: when it was asked; owner: the asking
 *   shim’s ShimConn owner; null for a record of a shim that sent no key (before #908), which no shim can take;
 *   undefined for a record an older daemon wrote, which the first shim to send it again takes; asked: the connections that sent it, the only ones its answer goes to;
 *   replayed: read back from prompts.jsonl at start, and no shim has sent it again since
 * @typedef {{ turn: string, id: string, at: number, reason: 'expired' | typeof CANCELED }} Expiry
 * @typedef {{ turn: string | null, owner: string, closed: boolean, send: (type: string, body: Record<string, unknown>) => void }} ShimConn
 *   owner: the SHA-256 of the key the shim sent in its hello, the same across its reconnects; a hello with none is
 *   refused (#908)
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
 * @typedef {{ paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>, now?: () => number, io?: { appendFile: Function, readFile: Function, stat: Function }, timers?: Timers,
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
  // The file calls behind the journal append (record), the snapshot read (snapshotOf) and the journal size check
  // (queueFull) go through this; the other file calls in the broker (exists, ended, the replay readers) do not. A test
  // gives its own to hold a read or a write, as the Store's io option does (store.mjs).
  io = { appendFile: fsp.appendFile, readFile: fsp.readFile, stat: fsp.stat },
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
    io,
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
    /** @type {Map<string, Promise<void>>} the writes in flight, in order, per file (broker-records.mjs chain) */
    appends: new Map(),
    ids: 0,
    closed: false,
  };
}

/**
 * Whether a call or a prompt is this connection’s shim’s, by its key (#353, #908): any client with a turn’s token can
 * name its id, so another key’s, or a keyless shim’s (null), is refused; one no shim owns yet (a record an older daemon
 * wrote) is taken by the first shim to send it. A call’s take is written down (broker-tools.mjs’s answerResend), so a
 * restart doesn’t leave it for anyone again; a prompt’s deliberately isn’t: it lasts at most permissionWaitMax, and
 * after a restart the first shim to send it again, or end it, takes it again.
 * @param {Tool | Prompt} r @param {ShimConn} c
 */
export function takes(r, c) {
  if (r.owner !== undefined && r.owner !== c.owner) return false;
  r.owner = c.owner;
  return true;
}

/**
 * Sends a call’s result to the connections of the shim that made it, by its key, never to every shim of the turn
 * (#908): any client with a turn’s token can connect as one of its shims. It goes to each live connection of that
 * shim, so one that reconnected while the call waited gets it without sending it again. A call no shim owns yet (a
 * record an older daemon wrote) reaches nobody until a shim sends it again and takes it (broker-tools.mjs).
 * @param {Broker} b @param {Tool} t @param {string} type @param {Record<string, unknown>} body
 */
export function toOwner(b, t, type, body) {
  if (t.owner === undefined) return;
  for (const s of b.shims.get(t.turn) ?? []) if (s.owner === t.owner) s.send(type, body);
}
