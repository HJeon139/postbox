// Codex’s approvals on the host (#120): the requests the app-server writes to out.jsonl, read while a held Codex
// turn runs, declined on the held stdin at permissionWaitMax, and the answers in in.jsonl that settle them. broker.mjs’s
// header says why in.jsonl is what says Codex got an answer.

import { promises as fsp } from 'node:fs';
import { REMOTE_LIMITS, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { sendExpiry, waitMax } from './broker-prompts.mjs';
import { ended, note, startOf } from './broker-records.mjs';
import { key } from './broker-state.mjs';

/**
 * @typedef {import('./broker-state.mjs').Broker} Broker
 * @typedef {import('./broker-state.mjs').CodexWatch} CodexWatch
 * @typedef {import('./broker-state.mjs').CodexRequest} CodexRequest
 * @typedef {import('./broker-state.mjs').LogPos} LogPos
 */

const READ_CHUNK = 64 * 1024;

/**
 * The Codex app-server requests the daemon declines at permissionWaitMax, each with the result that declines it, as
 * server/adapters/codex.mjs’s codexApproval answers a denial.
 */
export const CODEX_DECLINE = Object.freeze({
  'item/commandExecution/requestApproval': Object.freeze({ decision: 'decline' }),
  'item/fileChange/requestApproval': Object.freeze({ decision: 'decline' }),
  'mcpServer/elicitation/request': Object.freeze({ action: 'decline' }),
});

/** The protocol’s ID rule (remote-protocol.mjs’s ID_RE), for IDs the broker makes. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The ID a Codex request’s expiry carries to Postbox, or null if its JSON-RPC ID can’t make one. @param {unknown} rpcId */
export function codexPromptId(rpcId) {
  const id = `codex:${typeof rpcId === 'string' ? rpcId : JSON.stringify(rpcId)}`;
  return ID_RE.test(id) ? id : null;
}

/** The line that declines a Codex request on the held stdin. @param {string} method @param {unknown} rpcId */
export function codexDeclineLine(method, rpcId) {
  return JSON.stringify({ id: rpcId, result: CODEX_DECLINE[/** @type {keyof typeof CODEX_DECLINE} */ (method)] });
}

/** Starts reading a held Codex turn’s logs, if it is one. @param {Broker} b @param {string} turn */
export async function watchCodex(b, turn) {
  if (b.closed || b.watches.has(turn)) return;
  const start = await startOf(b, turn);
  if (start?.harness !== 'codex' || start.stdin !== 'held') return;
  /** @type {CodexWatch} */
  const w = {
    turn,
    out: { pos: 0, rest: Buffer.alloc(0), skipping: false },
    in: { pos: 0, rest: Buffer.alloc(0), skipping: false },
    requests: new Map(),
    pending: new Map(),
    answering: new Map(),
    settled: new Set(),
    declined: new Set(),
    tried: new Set(),
    timer: null,
    busy: false,
  };
  b.watches.set(turn, w);
  await pollCodex(b, w);
}

/** Reads what a log gained since the last look, line by line. @param {string} path @param {LogPos} at @param {(line: string) => void} onLine */
async function readOn(path, at, onLine) {
  let fh;
  try {
    fh = await fsp.open(path, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, at.pos);
      if (!bytesRead) return;
      at.pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      for (;;) {
        const nl = chunk.indexOf(10);
        if (nl === -1) {
          if (!at.skipping) at.rest = Buffer.concat([at.rest, chunk]);
          // A line longer than any the protocol carries isn’t a request to watch.
          if (at.rest.length > REMOTE_LIMITS.streamLineBytes) {
            at.rest = Buffer.alloc(0);
            at.skipping = true;
          }
          break;
        }
        const whole = at.skipping ? null : Buffer.concat([at.rest, chunk.subarray(0, nl)]);
        at.rest = Buffer.alloc(0);
        at.skipping = false;
        if (whole) onLine(whole.toString('utf8'));
        chunk = chunk.subarray(nl + 1);
      }
    }
  } finally {
    await fh.close();
  }
}

/** @param {Broker} b @param {CodexWatch} w */
async function pollCodex(b, w) {
  w.timer = null;
  if (b.closed || b.watches.get(w.turn) !== w || w.busy) return;
  w.busy = true;
  try {
    const over = await ended(b, w.turn);
    await readOn(b.p.turn(w.turn, TURN_FILES.out), w.out, (l) => fromCodex(b, w, l));
    await readOn(b.p.turn(w.turn, TURN_FILES.in), w.in, (l) => toCodex(b, w, l));
    if (over) {
      b.watches.delete(w.turn);
      return;
    }
    const limit = waitMax(b);
    for (const [k, req] of [...w.pending]) if (b.now() - req.seen >= limit) await decline(b, w, k, req, limit);
  } catch (e) {
    b.log(`Reading turn ${w.turn}’s Codex logs failed: ${e.stack ?? e.message}`);
  } finally {
    w.busy = false;
  }
  if (!b.closed && b.watches.get(w.turn) === w) w.timer = b.timers.setTimeout(() => pollCodex(b, w), b.codexPollMs);
}

const parse = (l) => {
  try {
    const v = JSON.parse(l);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
/** A line of the app-server’s stdout: an approval request, or the end of the turn that asked. @param {Broker} b @param {CodexWatch} w @param {string} l */
function fromCodex(b, w, l) {
  if (!l.includes('method')) return;
  const msg = parse(l);
  if (!msg || typeof msg.method !== 'string') return;
  if (msg.id != null && Object.hasOwn(CODEX_DECLINE, msg.method)) {
    const k = JSON.stringify(msg.id);
    if (w.requests.has(k) || w.settled.has(k)) return;
    const id = codexPromptId(msg.id);
    const rk = id ? key(w.turn, id) : null;
    const seen = (rk ? b.codexSeen.get(rk) : undefined) ?? b.now();
    /** @type {CodexRequest} */
    const req = { rpcId: msg.id, method: msg.method, id, seen };
    w.requests.set(k, req);
    w.pending.set(k, req);
    if (rk && !b.codexSeen.has(rk)) {
      b.codexSeen.set(rk, seen);
      note(b, w.turn, 'prompts', { op: 'codex', id, at: seen });
    }
    return;
  }
  // Requests a turn left unanswered end with it: the app-server no longer waits on them.
  if (msg.method === 'turn/completed') w.pending.clear();
  else if (msg.method === 'serverRequest/resolved' && msg.params?.requestId != null) w.pending.delete(JSON.stringify(msg.params.requestId));
}
/**
 * A line of the held stdin: Codex got this answer, so its request is settled, and the first answer is the one it
 * took. One this daemon didn’t write, or saw no write go for, came before it started (or its write failed after
 * the runner took the line): if it’s the decline the daemon sends, and Postbox didn’t write it or hear about it, the
 * daemon sent it and Postbox still needs its expiry.
 * @param {Broker} b @param {CodexWatch} w @param {string} l
 */
function toCodex(b, w, l) {
  const msg = response(l);
  if (!msg) return;
  const k = JSON.stringify(msg.id);
  w.pending.delete(k);
  if (w.settled.has(k)) return;
  w.settled.add(k);
  if (w.answering.has(k) || w.tried.has(k)) return;
  const req = w.requests.get(k);
  if (!req?.id || b.codexHeard.has(key(w.turn, req.id)) || msg.error !== undefined) return;
  if (JSON.stringify(msg.result) !== JSON.stringify(CODEX_DECLINE[/** @type {keyof typeof CODEX_DECLINE} */ (req.method)])) return;
  w.declined.add(k);
  sendExpiry(b, { turn: w.turn, id: req.id, at: b.now(), reason: 'expired' });
}

/**
 * Declines a request nobody answered: on the held stdin first, and only once the runner has taken the line (it’s in
 * in.jsonl) is it settled and Postbox told. While it’s on its way a `write` from Postbox for it is refused
 * (checkWrite); one the runner didn’t take leaves the request waiting for the next look, and Postbox hears nothing.
 * @param {Broker} b @param {CodexWatch} w @param {string} k @param {CodexRequest} req @param {number} limit
 */
async function decline(b, w, k, req, limit) {
  if (w.answering.has(k) || w.settled.has(k)) return;
  w.pending.delete(k);
  w.answering.set(k, 'decline');
  try {
    await b.writeStdin(w.turn, codexDeclineLine(req.method, req.rpcId));
  } catch (e) {
    w.answering.delete(k);
    b.log(`Couldn’t decline Codex’s request ${k} in turn ${w.turn}: ${e.message}. It’s tried again at the next look.`);
    if (!w.settled.has(k) && b.watches.get(w.turn) === w) w.pending.set(k, req);
    return;
  }
  w.answering.delete(k);
  w.settled.add(k);
  w.declined.add(k);
  b.log(`Turn ${w.turn}: nobody answered Codex’s ${req.method} (${k}) within ${Math.round(limit / 60_000)} minutes, so it was declined.`);
  if (req.id) sendExpiry(b, { turn: w.turn, id: req.id, at: b.now(), reason: 'expired' });
}

/**
 * Before the daemon writes a line to a held stdin for Postbox: a refusal for an answer to a request already
 * answered (in.jsonl has its answer, or a line for it went), or one on its way, or else a function to call with
 * whether the write went. A write that went is noted in prompts.jsonl (codex-answered), so a restart doesn’t take
 * Postbox’s own denial in in.jsonl for the daemon’s decline.
 * @param {Broker} b @param {string} turn @param {string} line
 * @returns {{ refused: string } | { done: (ok: boolean) => void }}
 */
export function checkWrite(b, turn, line) {
  const w = b.watches.get(turn);
  const msg = response(line);
  if (!msg || !w) return { done: () => {} };
  const k = JSON.stringify(msg.id);
  if (w.declined.has(k) || w.answering.get(k) === 'decline')
    return { refused: `Codex’s request ${k} was declined at the host’s permissionWaitMax, so this answer wasn’t sent.` };
  if (w.settled.has(k) || w.answering.has(k)) return { refused: `Codex’s request ${k} has been answered already, so this answer wasn’t sent.` };
  w.answering.set(k, 'write');
  w.tried.add(k);
  return {
    done: (ok) => {
      if (w.answering.get(k) === 'write') w.answering.delete(k);
      if (!ok) return;
      w.pending.delete(k);
      w.settled.add(k);
      const id = codexPromptId(msg.id);
      if (id) note(b, turn, 'prompts', { op: 'codex-answered', id });
    },
  };
}
/** A response line (no method, an id, a result or an error), parsed, or null. @param {string} line */
const response = (line) => {
  const msg = parse(line);
  return msg && msg.method === undefined && msg.id != null && ('result' in msg || 'error' in msg) ? msg : null;
};
