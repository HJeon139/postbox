// The daemon’s broker (#120): what the daemon does for each turn’s shim, and for Codex’s approval requests, between
// the agent on the host and Postbox on the laptop. The design is architecture.md, “Remote hosts”, “Postbox’s tools on
// the host” and “Permission prompts while nobody is connected”; the messages are shared/remote-protocol.mjs’s
// shim-to-daemon, daemon-to-shim, and the tool, prompt, prompt-expired, reply, answer, snapshot and snapshot-items
// messages between Postbox and the daemon. daemon.mjs hands it each shim connection and those Postbox messages.
//
// - A shim says hello with the host’s token (compared in constant time) and its turn. A turn that isn’t one the daemon
//   started, has ended, or is stopping is refused with turn-ended, as the laptop refuses a call from a stopped turn
//   (#126): Stop marks the turn stopping first, so a call made after it never reaches the conversation.
// - Each tool call is answered by its route (TOOL_ROUTES). A `queue` call is written to the turn folder’s tools.jsonl,
//   then the shim gets its result at once, so it stops resending, and it crosses to Postbox as `tool` now or after the
//   next hello. Postbox’s `reply` takes it off the queue; a refusal is logged, since the agent was already answered.
//   An `ask` call crosses the same way, and Postbox’s reply is the shim’s result; with no Postbox attached it fails at
//   once and says so. read_conversation and read_message are answered here, from the snapshot Postbox sent.
// - A permission prompt is written to prompts.jsonl and crosses as `prompt`. Postbox’s `answer` goes to the turn’s
//   shims as permission-answer, and again whenever a shim resends the prompt (after a reconnect), since the daemon
//   can’t tell whether a shim that went away read it. The shim’s notice that it expired, or that the harness canceled the call, ends it,
//   and Postbox hears prompt-expired, now or after its next hello.
// - A call or prompt is (turn, id): each shim picks its own IDs. A resent one is recognized and never queued twice.
// - Everything waiting for Postbox survives a daemon restart: tools.jsonl and prompts.jsonl are append-only records of
//   what arrived and what settled, replayed at start, an asked call’s reply with its text, so a shim that sends the
//   call again after a restart gets it. After each Postbox hello every unreplied tool, unanswered prompt and unsent
//   expiry is sent again; Postbox applies each identity once (the protocol’s header). A call or prompt is acknowledged
//   or sent on only once its record is on disk: one that can’t be written down is dropped and logged, and the shim
//   hears why (a call’s result with ok false, a prompt denied). Likewise an answer or reply settles its prompt or call,
//   and reaches the shim, only once it’s on disk: one that can’t be written down leaves it waiting, and Postbox hears
//   an error, so a restart never asks the person again or tells the harness something different. An expiry is
//   written down before it’s sent. One that can’t be still ends the prompt (the shim or the turn gave up on it), which
//   is kept in memory so it can’t be answered or sent again, and Postbox hears an error, not prompt-expired. After a
//   restart such a prompt waits again, with no shim waiting on it: a prompt read back from the records that no shim
//   sends again is ended at permissionWaitMax from when it was asked, when any shim would have given up on it.
//
// show_app and update_app name files in the agent’s folder on the host (codePath, files[].path), which Postbox can’t
// read. The broker reads them first, in start.json’s folder, by server/runtime.mjs’s appFiles rules and limits, and the
// `tool` carries `code` in place of codePath and `files` as [{ name, base64 }], made only here: a files entry Postbox
// gets always came from a path the broker read. The agent can change its folder while the broker reads, so each file
// is opened without following a link at the end of its path, and the file opened is checked to be in the folder
// before anything is read from it (folderFile). add_dataset reads a file on Postbox’s computer, which a remote agent
// can’t name, so it’s refused for now with a message that says so.
//
// The snapshot (`snapshot`, then `snapshot-items`) is kept in snapshot.json in the turn folder, 0600, written
// atomically, or in memory until `start` makes the folder. Its threads come in the order read_message looks through
// them (the turn’s own thread first, as server/runtime.mjs’s conversationThreads gives them), and each thread’s items
// are the ones read_conversation pages through, oldest first: an item with an empty line counts but isn’t shown, as
// runtime.mjs counts an item its describeItem leaves out.
//
// Codex’s approvals don’t go through the shim: the app-server writes each as a JSON-RPC request on its stdout, so it’s
// in out.jsonl, and the answer goes back on the held stdin, so it’s in in.jsonl. While a held Codex turn runs, the
// broker reads both as they grow. A request still unanswered permissionWaitMax after the broker first saw it is
// declined on the held stdin, with the response server/adapters/codex.mjs’s codexApproval sends for a denial, and
// Postbox hears prompt-expired with the ID codex:<request id>. in.jsonl is what says Codex got an answer: the runner
// appends each line to it before the pipe, so a request with a response there is settled, and a `write` that answers
// it again is refused, as is one while the daemon’s own decline or another write for it is on its way: Codex gets one
// answer to each request. The decline goes on the held stdin first, and Postbox hears only once the runner took it; if
// it didn’t, the request waits again for the next look. After a restart, a decline in in.jsonl that Postbox didn’t
// hear about (no expiry-sent) gets its expiry then, unless Postbox wrote it itself: prompts.jsonl’s codex-answered,
// written once its write went, says so (one written just before a crash can still be taken for the daemon’s, and
// Postbox hears an expiry for a prompt it answered, which it applies once and ignores).

import { constants as fsConstants, promises as fsp } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { validateBlock } from '../../../shared/catalog.mjs';
import { LIMITS, limitText, READING } from '../../../shared/limits.mjs';
import {
  encode,
  encodedBytes,
  FILE_MODE,
  HOST_DEFAULTS,
  message,
  parseLine,
  REMOTE_LIMITS,
  TOOL_ROUTES,
  TURN_FILES,
  validateMessage,
  validateStartRecord,
} from '../../../shared/remote-protocol.mjs';

/** Snapshots for turns not started yet, kept at most; and snapshots read from disk, kept in memory at most. */
const PENDING_SNAPSHOTS = 64;
const CACHED_SNAPSHOTS = 16;
/** How often a held Codex turn’s logs are read for approval requests and their answers. */
export const CODEX_POLL_MS = 1000;
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
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** The protocol’s words for a call the harness gave up on: prompt-expired’s reason, and the shim’s message. */
const CANCELED = /** @type {const} */ ('canceled');
const CANCELED_MSG = 'permission-canceled';

/** The ID a Codex request’s expiry carries to Postbox, or null if its JSON-RPC ID can’t make one. @param {unknown} rpcId */
export function codexPromptId(rpcId) {
  const id = `codex:${typeof rpcId === 'string' ? rpcId : JSON.stringify(rpcId)}`;
  return ID_RE.test(id) ? id : null;
}

/** The line that declines a Codex request on the held stdin. @param {string} method @param {unknown} rpcId */
export function codexDeclineLine(method, rpcId) {
  return JSON.stringify({ id: rpcId, result: CODEX_DECLINE[/** @type {keyof typeof CODEX_DECLINE} */ (method)] });
}

/** What the laptop says to a call from a stopped turn (server/mcp.mjs), word for word. */
export const STOPPED_TEXT = 'This call came from an agent turn that was stopped or has ended, so Postbox didn’t run it.';
/** The shim’s result for a call that’s queued: the agent already has its answer, so this only settles the shim’s copy. */
const QUEUED_TEXT = 'Queued for Postbox.';
const count = (n) => n.toLocaleString('en-US');
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── The snapshot’s reading tools ────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, line: string, text: string, blockId?: string }} SnapshotItem
 * @typedef {{ turn?: string, home: string, threads: { id: string, items: SnapshotItem[] }[] }} Snapshot
 * @typedef {{ ok: boolean, text: string }} Answer
 */

/**
 * read_conversation from a snapshot: server/runtime.mjs’s readConversation, with the same limits, paging and words.
 * @param {Snapshot} snap @param {any} [args]
 * @returns {Answer}
 */
export function readConversation(snap, args = {}) {
  const { limit = 50, skip = 0, thread = null } = args ?? {};
  const id = typeof thread === 'string' && thread.trim() ? thread.trim().slice(0, 100) : snap.home;
  const th = snap.threads.find((t) => t.id === id);
  if (!th) return { ok: false, text: `There’s no thread ${id} in this conversation. Read one of its own threads: the id is in the catch-up line or the link.` };
  const items = th.items;
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const end = Math.max(0, items.length - Math.max(0, Number(skip) || 0));
  const slice = items.slice(Math.max(0, end - n), end);
  const lines = slice.map((i) => i.line).filter(Boolean);
  const before = end - slice.length;
  return {
    ok: true,
    text: `${lines.join('\n\n') || 'The conversation is empty.'}${before ? `\n\n(${before} earlier ${before === 1 ? 'item' : 'items'}; call again with skip: ${items.length - before} to read them.)` : ''}`,
  };
}

/**
 * read_message from a snapshot: server/runtime.mjs’s readMessage, by item ID or a block’s ID, in parts of READING.part.
 * @param {Snapshot} snap @param {any} [args]
 * @returns {Answer}
 */
export function readMessage(snap, args = {}) {
  const { id, from = 0 } = args ?? {};
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, text: 'Name the item: read_message { id }, with an id from your history or read_conversation.' };
  let it = snap.threads.map((th) => th.items.find((i) => i.id === key)).find(Boolean);
  if (!it) {
    const blocks = snap.threads.flatMap((th) => th.items.filter((i) => i.blockId === key));
    // The laptop names each block’s agent here; the snapshot carries only their item IDs.
    if (blocks.length > 1)
      return { ok: false, text: `More than one block is called “${key}”: they’re the items ${blocks.map((b) => b.id).join(', ')}. Read one by that id.` };
    it = blocks[0];
  }
  if (!it)
    return {
      ok: false,
      text: `There’s no item “${clipText(key, 80)}” in this conversation. Your history and read_conversation give the id of each item they cut.`,
    };
  const full = it.text;
  if (!full) return { ok: false, text: `${it.id} has nothing to read.` };
  const start = Math.max(0, Math.min(full.length, Math.floor(Number(from) || 0)));
  if (start >= full.length) return { ok: true, text: `Nothing after character ${count(full.length)}: that’s the end of ${it.id}.` };
  const end = Math.min(full.length, start + READING.part);
  if (start === 0 && end === full.length) return { ok: true, text: full };
  const more = end < full.length ? ` read_message { id: "${it.id}", from: ${end} } reads on.` : '';
  return { ok: true, text: `${full.slice(start, end)}\n\n(Characters ${count(start + 1)}–${count(end)} of ${count(full.length)}.${more})` };
}

// ── Files in the agent’s folder ─────────────────────────────────────────────────────

/** @typedef {{ ok: true, args: Record<string, any> } | { ok: false, text: string }} Prepared */

/** Whether a real path is the folder or under it. @param {string} root @param {string} real */
const inside = (root, real) => real === root || real.startsWith(root === sep ? root : root + sep);
/**
 * How a checked file is opened: never through a link at the end of its path (one swapped in after the check fails
 * with ELOOP), and never waiting on a FIFO swapped in for it. Neither flag changes how a regular file reads.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Whether the file an open descriptor reads is in the folder, found from the descriptor, not the path, so a folder on
 * the path swapped for a link after the check is caught too. Linux’s /proc/self/fd names the file itself. Without
 * /proc (macOS), the path is resolved again and must still be in the folder and be the very file opened (device and
 * inode): a swap before the open makes it name another file, or one outside.
 * @param {import('node:fs/promises').FileHandle} fh @param {string} root @param {string} real
 */
async function openedInside(fh, root, real) {
  const named = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
  if (named !== null) return inside(root, named);
  const now = await fsp.realpath(real).catch(() => null);
  if (!now || !inside(root, now)) return false;
  const [a, b] = await Promise.all([fh.stat({ bigint: true }), fsp.lstat(now, { bigint: true })]);
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Reads a file the agent named, in its folder on the host, followed through links so a link can’t reach outside it.
 * server/runtime.mjs’s agentFile, with one folder. The agent can change its folder while this runs, so the path is
 * checked, then the file opened is checked again (openedInside), and what’s read comes from that open file.
 * @param {string} folder @param {unknown} path @param {number} max @param {string} what
 * @param {{ beforeOpen?: (real: string) => unknown }} [hooks]  for tests: beforeOpen runs between the check and the open
 * @returns {Promise<{ ok: true, buf: Buffer } | { ok: false, text: string }>}
 */
async function folderFile(folder, path, max, what, hooks = {}) {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, text: `${what} needs a path to a file in your folder.` };
  const root = await fsp.realpath(folder).catch(() => null);
  if (!root) return { ok: false, text: `Your folder on this host, ${folder}, isn’t there, so Postbox couldn’t read ${what}.` };
  const real = await fsp.realpath(resolve(folder, path)).catch(() => null);
  if (!real) return { ok: false, text: `There’s no file at ${path} (${what}).` };
  const outside = { ok: /** @type {const} */ (false), text: `${path} is outside your folder, so Postbox didn’t read it (${what}).` };
  if (!inside(root, real)) return outside;
  const over = { ok: /** @type {const} */ (false), text: `${path} is over the limit for ${what}.` };
  let fh;
  try {
    await hooks.beforeOpen?.(real);
    fh = await fsp.open(real, OPEN_FLAGS);
    if (!(await openedInside(fh, root, real))) return outside;
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, text: `${path} isn’t a file (${what}).` };
    if (st.size > max) return over;
    // A file still being written can grow after the stat, so the read itself stops one byte past the limit.
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > max) return over;
    }
    return { ok: true, buf: Buffer.concat(chunks, total) };
  } catch (e) {
    // ELOOP: the file became a link after the check.
    if (e.code === 'ELOOP') return outside;
    return { ok: false, text: `Couldn’t read ${path} (${what}): ${e.message}` };
  } finally {
    await fh?.close();
  }
}

/**
 * show_app’s and update_app’s codePath and files, read from the agent’s folder: server/runtime.mjs’s appFiles, except
 * that the files go in the call as base64 for Postbox to store.
 * @param {string} folder @param {Record<string, any>} args @param {{ beforeOpen?: (real: string) => unknown }} [hooks]  for tests
 * @returns {Promise<Prepared>}
 */
export async function inlineAppFiles(folder, args, hooks = {}) {
  const { codePath, files: wanted, ...rest } = args;
  /** @type {Record<string, any>} */
  const out = { ...rest };
  if (codePath !== undefined) {
    if (typeof rest.code === 'string' && rest.code) return { ok: false, text: 'Send code or codePath, not both.' };
    // A character is at most 4 bytes, so a file within the limit in characters is within 4 times it in bytes.
    const r = await folderFile(folder, codePath, LIMITS.appCode * 4, 'codePath', hooks);
    if (!r.ok) return r;
    out.code = r.buf.toString('utf8');
    if (out.code.length > LIMITS.appCode)
      return { ok: false, text: `${codePath} has ${count(out.code.length)} characters; an app’s code is up to ${limitText('appCode')}.` };
  }
  if (wanted === undefined) return { ok: true, args: out };
  if (!Array.isArray(wanted)) return { ok: false, text: 'files is a list: [{ name?, path }].' };
  if (wanted.length > LIMITS.appFiles) return { ok: false, text: `An app carries up to ${limitText('appFiles')} data files.` };
  /** @type {{ name: string, base64: string }[]} */
  const files = [];
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) return { ok: false, text: `“${name}” can’t name a file: use letters, digits and - _ . (up to 64).` };
    if (files.some((x) => x.name === name)) return { ok: false, text: `Two files are named “${name}”.` };
    const r = await folderFile(folder, path, LIMITS.appFileBytes, `the file “${name}” (up to ${limitText('appFileBytes')})`, hooks);
    if (!r.ok) return r;
    files.push({ name, base64: r.buf.toString('base64') });
  }
  out.files = files;
  return { ok: true, args: out };
}

// ── The broker ──────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ turn: string, id: string, name: string, route: 'queue' | 'ask', args: Record<string, any> | null, replied: boolean,
 *   result?: { ok: boolean, text: string }, saved?: Promise<string>, replying?: Promise<string> }} Tool
 *   saved: settles once the call is written down, with '' or why it couldn’t be (a prompt’s likewise); replying: a
 *   reply being written down, likewise (a prompt’s answering)
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
 */

/**
 * The broker for one daemon. Everything it needs from the daemon is passed in, so tests drive it without one.
 * @param {{ paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>, now?: () => number, timers?: Timers,
 *   log?: (line: string) => void, tokenMatches: (token: string) => boolean, settings?: () => Record<string, any>,
 *   toPostbox: (type: string, body: Record<string, unknown>) => boolean, attached: () => boolean,
 *   interrupted?: (turn: string) => boolean, writeStdin?: (turn: string, line: string) => Promise<unknown>, codexPollMs?: number }} o
 *   toPostbox: sends to the attached Postbox, false if none is; interrupted: the daemon found the turn’s runner isn’t
 *   the one runner.json names; writeStdin: one line for a turn’s held stdin, through its runner
 */
export function createBroker({
  paths: p,
  now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (t) => clearTimeout(t) },
  log = () => {},
  tokenMatches,
  settings = () => HOST_DEFAULTS,
  toPostbox,
  attached,
  interrupted = () => false,
  writeStdin = async () => {
    throw new Error('this daemon can’t write to a held stdin');
  },
  codexPollMs = CODEX_POLL_MS,
}) {
  const key = (turn, id) => `${turn} ${id}`;
  /** @type {Map<string, Tool>} every call seen, by (turn, id); a replied one keeps no args */
  const tools = new Map();
  /** @type {Map<string, Prompt>} */
  const prompts = new Map();
  /** @type {Map<string, Expiry>} prompt-expired not yet sent to Postbox */
  const expiries = new Map();
  /** Turns Stop was sent for: their shims are refused from then on. */
  const stopping = new Set();
  /** @type {Map<string, Set<ShimConn>>} the shims connected, by turn */
  const shims = new Map();
  /** @type {Map<string, Snapshot>} */
  const pendingSnapshots = new Map();
  /** @type {Map<string, Snapshot>} */
  const cachedSnapshots = new Map();
  /** @type {Map<string, CodexWatch>} */
  const watches = new Map();
  /** Codex requests first seen (from prompts.jsonl), by (turn, codex ID). */
  /** @type {Map<string, number>} */
  const codexSeen = new Map();
  /** Codex requests Postbox has heard about from prompts.jsonl, its own answer or the expiry, by (turn, codex ID). */
  const codexHeard = new Set();
  /** Prompts that ended without their record: never answered or sent again, by (turn, id). */
  const unrecordedEnds = new Set();
  /** The timers that end prompts read back at start that no shim sent again. */
  const orphanTimers = new Set();
  /** @type {Map<string, Promise<void>>} appends in order, per file */
  const appends = new Map();
  let ids = 0;
  let closed = false;

  // ── Files ──

  const exists = (path) =>
    fsp.lstat(path).then(
      () => true,
      () => false,
    );
  /**
   * Appends one record to a turn’s tools.jsonl or prompts.jsonl, in order. It rejects if the append fails, after logging
   * it, so a call or prompt is acknowledged only once it’s on disk; a failed append doesn’t hold up the next one.
   * @param {string} turn @param {'tools' | 'prompts'} which @returns {Promise<void>}
   */
  function record(turn, which, rec) {
    const path = p.turn(turn, TURN_FILES[which]);
    const line = `${JSON.stringify({ ...rec, at: rec.at ?? now() })}\n`;
    const next = (appends.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(() => fsp.appendFile(path, line, { mode: FILE_MODE }))
      .catch((e) => {
        log(`Couldn’t record ${rec.op} in ${path}: ${e.message}`);
        throw e;
      });
    appends.set(path, next);
    const done = () => {
      if (appends.get(path) === next) appends.delete(path);
    };
    next.then(done, done);
    return next;
  }
  /** A record nothing waits on: a failure is logged by record, and the state in memory still holds. */
  const note = (turn, which, rec) => record(turn, which, rec).catch(() => {});
  /** A record as a promise of '' once it’s on disk, or the error’s message. */
  const written = (turn, which, rec) =>
    record(turn, which, rec).then(
      () => '',
      (e) => e.message,
    );
  /** What the shim hears when a call or prompt couldn’t be written down. @param {string} what @param {Error} e */
  const unrecorded = (what, e) =>
    `Postbox’s daemon on this host couldn’t write down ${what}, so it wasn’t ${what.startsWith('this permission') ? 'shown' : 'sent to Postbox'}: ${e.message}. Try again.`;
  /** Writes a file atomically, mode 0600. */
  const writeAtomic = async (path, text) => {
    const tmp = `${path}.${process.pid}.b${++ids}.tmp`;
    await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
    await fsp.rename(tmp, path);
  };
  /** start.json, if the turn is one the daemon started. @param {string} turn */
  const startOf = async (turn) => {
    try {
      const r = validateStartRecord(JSON.parse(await fsp.readFile(p.turn(turn, TURN_FILES.start), 'utf8')));
      return r.ok ? r.msg : null;
    } catch {
      return null;
    }
  };
  const ended = (turn) => exists(p.turn(turn, TURN_FILES.exit));

  // ── To Postbox ──

  /** @param {Tool} t */
  const toolBody = (t) => ({ turn: t.turn, id: t.id, name: t.name, args: t.args ?? {} });
  /** @param {Prompt} q */
  const promptBody = (q) => ({ id: q.id, turn: q.turn, request: q.request });
  /** Sends an expiry if Postbox is attached; it waits for the next hello if not. @param {Expiry} x */
  function sendExpiry(x) {
    const k = key(x.turn, x.id);
    expiries.set(k, x);
    if (toPostbox('prompt-expired', { id: x.id, turn: x.turn, at: x.at, reason: x.reason })) {
      expiries.delete(k);
      note(x.turn, 'prompts', { op: 'expiry-sent', id: x.id });
    }
  }
  /**
   * Ends a prompt nobody can answer any more: it’s recorded, dropped, and Postbox hears now, or with the rest of a
   * hello’s resend (`later`). It’s written down before Postbox hears, so a restart right after doesn’t show the prompt
   * again. One that can’t be written down still ends (record logged why): the shim, or the turn, has given up on it.
   * But a restart would show it again, so Postbox isn’t told it’s over as if that were kept: it hears an error, and the
   * prompt is kept in memory as ended, so it can’t be answered or sent again (unrecordedEnds).
   * @param {string} turn @param {string} id @param {number} at @param {Expiry['reason']} reason
   */
  async function endPrompt(turn, id, at, reason, later = false) {
    const why = await written(turn, 'prompts', { op: 'expired', id, at, reason });
    const k = key(turn, id);
    const q = prompts.get(k);
    if (q) q.over = true;
    prompts.delete(k);
    if (why) {
      unrecordedEnds.add(k);
      const what = reason === CANCELED ? 'was canceled' : 'expired';
      toPostbox('error', {
        code: 'internal',
        re: 'prompt-expired',
        turn,
        id,
        message:
          `Postbox’s daemon on this host couldn’t write down that prompt ${id} in turn ${turn} ${what}: ${why}. It can’t be answered any more; if the daemon restarts, it may show as waiting until the host’s permissionWaitMax from when it was asked.`.slice(
            0,
            REMOTE_LIMITS.messageChars,
          ),
      });
      return;
    }
    if (later) expiries.set(k, { turn, id, at, reason });
    else sendExpiry({ turn, id, at, reason });
  }
  /** How long a shim waits on a prompt, and the daemon on a Codex request, in milliseconds. */
  const waitMax = () => Number(settings().permissionWaitMax ?? HOST_DEFAULTS.permissionWaitMax);
  /**
   * A prompt read back at start that no shim has sent again, past permissionWaitMax from when it was asked: no shim
   * still waits for it (each gives up by then, from when it asked, which is before the record), so it’s ended.
   * @param {Prompt} q
   */
  const orphaned = (q) => Boolean(q.replayed) && !q.answer && now() >= q.at + waitMax();
  /** Ends a prompt read back at start once it’s orphaned, unless a shim sends it again first. @param {Prompt} q */
  function armOrphan(q) {
    if (closed) return;
    const t = timers.setTimeout(
      () => {
        orphanTimers.delete(t);
        if (closed || prompts.get(key(q.turn, q.id)) !== q || !q.replayed || q.answer) return;
        if (!orphaned(q)) return armOrphan(q);
        return endPrompt(q.turn, q.id, now(), 'expired');
      },
      Math.max(0, q.at + waitMax() - now()),
    );
    orphanTimers.add(t);
  }

  // ── To shims ──

  /** @param {string} turn @param {string} type @param {Record<string, unknown>} body */
  function toShims(turn, type, body) {
    for (const s of shims.get(turn) ?? []) s.send(type, body);
  }

  // ── The snapshot ──

  /** @param {string} turn @returns {Promise<Snapshot | null>} */
  async function snapshotOf(turn) {
    const had = cachedSnapshots.get(turn) ?? pendingSnapshots.get(turn);
    if (had) return had;
    let snap;
    try {
      snap = JSON.parse(await fsp.readFile(p.turn(turn, TURN_FILES.snapshot), 'utf8'));
    } catch {
      return null;
    }
    if (!snap || typeof snap.home !== 'string' || !Array.isArray(snap.threads)) return null;
    cache(turn, snap);
    return snap;
  }
  /** @param {string} turn @param {Snapshot} snap */
  function cache(turn, snap) {
    cachedSnapshots.delete(turn);
    cachedSnapshots.set(turn, snap);
    while (cachedSnapshots.size > CACHED_SNAPSHOTS) cachedSnapshots.delete(/** @type {string} */ (cachedSnapshots.keys().next().value));
  }
  /** Keeps a turn’s snapshot: in its folder once there is one, else in memory until `start`. @param {string} turn @param {Snapshot} snap */
  async function saveSnapshot(turn, snap) {
    if (await exists(p.turn(turn))) {
      await writeAtomic(p.turn(turn, TURN_FILES.snapshot), JSON.stringify(snap));
      pendingSnapshots.delete(turn);
      cache(turn, snap);
      return;
    }
    pendingSnapshots.delete(turn);
    pendingSnapshots.set(turn, snap);
    while (pendingSnapshots.size > PENDING_SNAPSHOTS) pendingSnapshots.delete(/** @type {string} */ (pendingSnapshots.keys().next().value));
  }

  /** @param {any} m @param {{ fail: (code: string, text: string) => void }} reply */
  async function snapshotItems(m, reply) {
    const snap = await snapshotOf(m.turn);
    if (!snap) return reply.fail('no-turn', `There’s no snapshot for turn ${m.turn} on this host. Send snapshot first.`);
    let th = snap.threads.find((t) => t.id === m.thread);
    if (!th) {
      if (snap.threads.length >= REMOTE_LIMITS.snapshotThreads)
        return reply.fail('bad-message', `Turn ${m.turn}’s snapshot already has ${REMOTE_LIMITS.snapshotThreads} threads, so ${m.thread} wasn’t added.`);
      th = { id: m.thread, items: [] };
      snap.threads.push(th);
    }
    const at = new Map(th.items.map((it, i) => [it.id, i]));
    for (const it of m.items) {
      const i = at.get(it.id);
      if (i === undefined) {
        at.set(it.id, th.items.length);
        th.items.push(it);
      } else th.items[i] = it;
    }
    // The oldest go first: read_conversation reads from the newest.
    if (th.items.length > REMOTE_LIMITS.snapshotItems) th.items.splice(0, th.items.length - REMOTE_LIMITS.snapshotItems);
    await saveSnapshot(m.turn, snap);
  }

  // ── Shim calls ──

  /**
   * What a turn’s shim may do: '' if it may call, else why not, with the error code.
   * @param {string} turn @returns {Promise<{ code: string, text: string } | null>}
   */
  async function refusal(turn) {
    if (!(await startOf(turn))) return { code: 'no-turn', text: `There’s no turn ${turn} on this host.` };
    if (stopping.has(turn) || interrupted(turn) || (await ended(turn))) return { code: 'turn-ended', text: STOPPED_TEXT };
    return null;
  }

  /**
   * A call for Postbox: shown, checked or read from the agent’s folder as the laptop would before it’s queued.
   * @param {string} turn @param {string} name @param {Record<string, any>} args @returns {Promise<Prepared>}
   */
  async function prepare(turn, name, args) {
    if (name === 'add_dataset')
      return {
        ok: false,
        text: 'Loading a dataset isn’t supported yet for an agent on a remote host: add_dataset reads a file on Postbox’s own computer, which this host can’t reach, so nothing was loaded.',
      };
    let out = args;
    if (name === 'show_app' || name === 'update_app') {
      const start = await startOf(turn);
      if (!start) return { ok: false, text: `There’s no turn ${turn} on this host.` };
      const r = await inlineAppFiles(start.folder, args);
      if (!r.ok) return r;
      out = r.args;
    }
    // Only what the laptop would refuse outright is refused here; an invalid show_block or show_app still goes, since
    // the laptop shows its fallback text (server/runtime.mjs’s show_block).
    if (name === 'update_block') {
      const v = validateBlock(out.block);
      if (!v.ok) return { ok: false, text: `The update was invalid and wasn’t applied: ${v.errors.join(' ')}` };
    }
    if (name === 'update_app' && typeof out.code === 'string') {
      const v = validateBlock({
        id: out.id,
        type: 'app',
        version: 1,
        fallback: 'x',
        code: out.code,
        ...(out.permissions ? { permissions: out.permissions } : {}),
      });
      if (!v.ok) return { ok: false, text: `The update was invalid: ${v.errors.join(' ')}` };
    }
    const size = encodedBytes({ type: 'tool', turn, id: 'x'.repeat(128), name, args: out });
    if (size > REMOTE_LIMITS.lineBytes)
      return {
        ok: false,
        text: `${name} comes to ${(size / 1024 / 1024).toFixed(1)} MiB once its files are read, over the ${REMOTE_LIMITS.lineBytes / 1024 / 1024} MiB one call from this host to Postbox can carry. Send fewer or smaller files.`,
      };
    return { ok: true, args: out };
  }

  /** @param {ShimConn} c @param {string} turn @param {any} m */
  async function call(c, turn, m) {
    const result = (ok, text) => c.send('result', { id: m.id, ok, text: text.slice(0, REMOTE_LIMITS.replyChars) });
    const no = await refusal(turn);
    if (no) {
      result(false, no.text);
      return c.send('error', { code: no.code, message: no.text });
    }
    const route = TOOL_ROUTES[/** @type {keyof typeof TOOL_ROUTES} */ (m.name)];
    if (route === 'host') {
      const snap = await snapshotOf(turn);
      if (!snap) return result(false, `Postbox hasn’t sent this host the conversation yet, so ${m.name} can’t read it. Try again in a moment.`);
      const r = m.name === 'read_message' ? readMessage(snap, m.args) : readConversation(snap, m.args);
      return result(r.ok, r.text);
    }
    const k = key(turn, m.id);
    const known = tools.get(k);
    if (known) {
      // Sent again after a reconnect: settled already, or still waiting on Postbox. One still being written down waits
      // for that, so it isn’t acknowledged before it’s on disk.
      const saved = await known.saved;
      if (saved) return result(false, saved);
      if (known.route === 'queue') return result(true, QUEUED_TEXT);
      if (known.result) return result(known.result.ok, known.result.text);
      if (known.replied) return result(false, `Postbox answered ${known.name} before this host’s daemon restarted, but the answer wasn’t kept. Call it again.`);
      return;
    }
    if (route === 'ask' && !attached() && m.name !== 'add_dataset')
      return result(false, `Postbox isn’t connected to this host right now, so ${m.name} can’t run. Try again once Postbox is open and connected.`);
    const r = await prepare(turn, m.name, m.args);
    if (!r.ok) {
      log(`Turn ${turn}’s ${m.name} (${m.id}) was refused: ${r.text}`);
      return result(false, r.text);
    }
    /** @type {Tool} */
    const t = { turn, id: m.id, name: m.name, route: /** @type {'queue' | 'ask'} */ (route), args: r.args, replied: false };
    tools.set(k, t);
    // Written down before the shim hears or Postbox sees it, so a queued call outlives a crash right after. One that
    // can’t be written isn’t kept: the shim hears why, and the same call can go once the file can be written.
    t.saved = record(turn, 'tools', { op: 'call', id: t.id, name: t.name, route: t.route, args: t.args }).then(
      () => '',
      (e) => unrecorded(t.name, e),
    );
    const saved = await t.saved;
    if (saved) {
      if (tools.get(k) === t) tools.delete(k);
      return result(false, saved);
    }
    if (route === 'queue') result(true, QUEUED_TEXT);
    toPostbox('tool', toolBody(t));
  }

  /** @param {ShimConn} c @param {string} turn @param {any} m */
  async function permission(c, turn, m) {
    const no = await refusal(turn);
    if (no) return c.send('error', { code: no.code, message: no.text });
    const k = key(turn, m.id);
    const known = prompts.get(k);
    /** A prompt that couldn’t be written down is denied, never left waiting or allowed. @param {string} text */
    const deny = (text) => c.send('permission-answer', { id: m.id, result: { behavior: 'deny', message: text.slice(0, REMOTE_LIMITS.messageChars) } });
    if (known) {
      // A shim still waits on it: it ends the prompt itself.
      known.replayed = false;
      const saved = await known.saved;
      if (saved) return deny(saved);
      if (known.answer) c.send('permission-answer', { id: m.id, result: known.answer });
      return;
    }
    if (unrecordedEnds.has(k)) return deny(`Permission request ${m.id} has ended already, so it can’t be shown again.`);
    /** @type {Prompt} */
    const q = { turn, id: m.id, request: m.request, answer: null, over: false, at: now() };
    prompts.set(k, q);
    // Shown only once it’s on disk, as a queued call is acknowledged only then (call).
    q.saved = record(turn, 'prompts', { op: 'prompt', id: q.id, request: q.request, at: q.at }).then(
      () => '',
      (e) => unrecorded('this permission request', e),
    );
    const saved = await q.saved;
    if (saved) {
      if (prompts.get(k) === q) prompts.delete(k);
      return deny(saved);
    }
    if (!q.over) toPostbox('prompt', promptBody(q));
  }

  /**
   * A shim’s connection to the daemon’s socket. Its first line is its hello.
   * @param {{ first: string, write: (s: string) => boolean, end: () => void }} io
   */
  function shim({ first, write, end }) {
    /** @type {ShimConn} */
    const c = {
      turn: null,
      closed: false,
      send(type, body) {
        if (c.closed) return;
        try {
          write(encode(message('daemon-to-shim', type, body)));
        } catch (e) {
          log(`Couldn’t send ${type} to turn ${c.turn}’s shim: ${e.message}`);
        }
      },
    };
    const refuse = (code, text) => {
      c.send('error', { code, message: text.slice(0, REMOTE_LIMITS.messageChars) });
      close();
      try {
        end();
      } catch {}
    };
    const close = () => {
      if (c.closed) return;
      c.closed = true;
      if (c.turn) shims.get(c.turn)?.delete(c);
      if (c.turn && !shims.get(c.turn)?.size) shims.delete(c.turn);
    };
    /** @param {string} text */
    const handle = async (text) => {
      const r = parseLine('shim-to-daemon', text);
      if (!r.ok) {
        if (!c.turn) return refuse('bad-message', r.error);
        return c.send('error', { code: 'bad-message', message: r.error.slice(0, REMOTE_LIMITS.messageChars) });
      }
      const m = r.msg;
      if (!c.turn) {
        if (m.type !== 'hello') return refuse('not-ready', 'Say hello with the host’s token and your turn first.');
        if (!tokenMatches(m.token)) return refuse('bad-token', 'The token doesn’t match the host’s, in ~/.postbox-remote/token.');
        const no = await refusal(m.turn);
        if (no) return refuse(no.code, no.text);
        if (c.closed) return;
        c.turn = m.turn;
        if (!shims.has(m.turn)) shims.set(m.turn, new Set());
        shims.get(m.turn)?.add(c);
        c.send('welcome', { turn: m.turn, permissionWaitMax: settings().permissionWaitMax ?? HOST_DEFAULTS.permissionWaitMax });
        return;
      }
      const turn = c.turn;
      switch (m.type) {
        case 'hello':
          return c.send('error', { code: 'bad-message', message: 'This connection has said hello already.' });
        case 'call':
          return call(c, turn, m);
        case 'permission':
          return permission(c, turn, m);
        case 'permission-expired':
        case CANCELED_MSG:
          return endPrompt(turn, m.id, m.at, m.type === 'permission-expired' ? 'expired' : CANCELED);
      }
    };
    /** @type {Promise<void>} */
    let queue = Promise.resolve();
    const line = (text) => {
      queue = queue.then(() => (c.closed ? undefined : handle(text))).catch((e) => log(`A shim message failed: ${e.stack ?? e.message}`));
    };
    line(first);
    return { line, close };
  }

  // ── Postbox’s messages ──

  /**
   * snapshot, snapshot-items, answer and reply; false for any other.
   * @param {any} m @param {{ send: (type: string, body: Record<string, unknown>) => void, fail: (code: string, text: string) => void }} reply
   */
  async function onMessage(m, reply) {
    switch (m.type) {
      case 'snapshot':
        await saveSnapshot(m.turn, { turn: m.turn, home: m.home, threads: m.threads });
        return true;
      case 'snapshot-items':
        await snapshotItems(m, reply);
        return true;
      case 'answer': {
        const k = key(m.turn, m.prompt);
        // An answer still being written down settles first: this one is then a repeat, or the next try.
        while (prompts.get(k)?.answering) await prompts.get(k)?.answering;
        const q = prompts.get(k);
        if (!q) {
          reply.fail(
            'no-prompt',
            unrecordedEnds.has(k)
              ? `Prompt ${m.prompt} in turn ${m.turn} has ended (the agent gave up on it), so it can’t be answered.`
              : `There’s no prompt ${m.prompt} waiting in turn ${m.turn}.`,
          );
          return true;
        }
        if (stopping.has(m.turn)) {
          reply.fail('no-prompt', `Turn ${m.turn} was stopped, so prompt ${m.prompt} can’t be answered.`);
          return true;
        }
        if (!q.answer) {
          // Written down before it’s taken or the shim hears it, so a restart right after neither asks the person
          // again nor gives the harness a different answer. One that can’t be written leaves the prompt waiting.
          q.answering = written(m.turn, 'prompts', { op: 'answer', id: q.id, result: m.result });
          const why = await q.answering;
          q.answering = undefined;
          if (why) {
            reply.fail(
              'internal',
              `Postbox’s daemon on this host couldn’t write down the answer to prompt ${q.id} in turn ${m.turn}, so the agent didn’t get it: ${why}. Answer again.`,
            );
            return true;
          }
          q.answer = m.result;
          // The shim gave up on it, or the turn stopped, while it was written down.
          if (q.over) {
            reply.fail('no-prompt', `Prompt ${q.id} in turn ${m.turn} ended before its answer reached the agent.`);
            return true;
          }
        }
        toShims(m.turn, 'permission-answer', { id: q.id, result: q.answer });
        return true;
      }
      case 'reply': {
        const k = key(m.turn, m.id);
        while (tools.get(k)?.replying) await tools.get(k)?.replying;
        const t = tools.get(k);
        if (!t || t.replied) {
          reply.fail('no-tool', `There’s no tool call ${m.id} waiting in turn ${m.turn}.`);
          return true;
        }
        // Written down before it’s taken or the shim hears it: an asked call’s answer is kept, with its text, for a
        // shim that sends the call again after the daemon restarts. One that can’t be written leaves the call waiting.
        t.replying = written(m.turn, 'tools', { op: 'reply', id: t.id, ok: m.ok, ...(t.route === 'ask' ? { text: m.text } : {}) });
        const why = await t.replying;
        t.replying = undefined;
        if (why) {
          reply.fail(
            'internal',
            `Postbox’s daemon on this host couldn’t write down the reply to call ${t.id} in turn ${m.turn}, so it wasn’t taken: ${why}. Reply again.`,
          );
          return true;
        }
        t.replied = true;
        t.args = null;
        if (t.route === 'ask') {
          t.result = { ok: m.ok, text: m.text };
          toShims(m.turn, 'result', { id: t.id, ok: m.ok, text: m.text });
        } else if (!m.ok) log(`Postbox refused turn ${m.turn}’s ${t.name} (${t.id}): ${m.text}`);
        return true;
      }
    }
    return false;
  }

  /**
   * After each welcome: everything still waiting for Postbox, again. A prompt whose turn has ended can’t be answered,
   * nor one no shim waits for (orphaned), so it’s ended instead.
   * @param {(type: string, body: Record<string, unknown>) => void} send
   */
  async function onHello(send) {
    const turns = new Set([...tools.values(), ...prompts.values(), ...expiries.values()].map((x) => x.turn));
    const gone = new Set();
    const over = new Set();
    for (const turn of turns) {
      if (!(await exists(p.turn(turn)))) gone.add(turn);
      else if (await ended(turn)) over.add(turn);
    }
    // A folder that went (H5’s cleanup) takes its records with it.
    for (const map of [tools, prompts, expiries]) for (const [k, x] of map) if (gone.has(x.turn)) map.delete(k);
    await Promise.all(
      [...prompts.values()]
        .filter((q) => !q.answer && (over.has(q.turn) || orphaned(q)))
        .map((q) => endPrompt(q.turn, q.id, now(), over.has(q.turn) ? CANCELED : 'expired', true)),
    );
    for (const t of tools.values()) if (!t.replied) send('tool', toolBody(t));
    for (const q of prompts.values()) if (!q.answer) send('prompt', promptBody(q));
    for (const [k, x] of [...expiries]) {
      send('prompt-expired', { id: x.id, turn: x.turn, at: x.at, reason: x.reason });
      expiries.delete(k);
      note(x.turn, 'prompts', { op: 'expiry-sent', id: x.id });
    }
  }

  // ── Restart ──

  /** Each JSON line of a turn file; a torn last line (a crash mid-append) is skipped. @param {string} path */
  async function lines(path) {
    let text;
    try {
      text = await fsp.readFile(path, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const l of text.split('\n')) {
      if (!l) continue;
      try {
        const v = JSON.parse(l);
        if (v && typeof v === 'object' && typeof v.op === 'string' && typeof v.id === 'string') out.push(v);
      } catch {}
    }
    return out;
  }

  /** Replays one turn’s tools.jsonl and prompts.jsonl. @param {string} turn */
  async function loadTurn(turn) {
    for (const r of await lines(p.turn(turn, TURN_FILES.tools))) {
      const k = key(turn, r.id);
      if (r.op === 'stopping') stopping.add(turn);
      else if (r.op === 'call' && !tools.has(k) && (r.route === 'queue' || r.route === 'ask') && Object.hasOwn(TOOL_ROUTES, r.name)) {
        const body = { turn, id: r.id, name: r.name, args: r.args ?? {} };
        // A record that wouldn’t make a valid tool message is left out, never sent.
        if (validateMessage('daemon-to-postbox', { type: 'tool', ...body }).ok)
          tools.set(k, { turn, id: r.id, name: r.name, route: r.route, args: r.args, replied: false });
      } else if (r.op === 'reply') {
        const t = tools.get(k);
        if (t) {
          t.replied = true;
          t.args = null;
          if (t.route === 'ask' && typeof r.ok === 'boolean' && typeof r.text === 'string' && r.text.length <= REMOTE_LIMITS.replyChars)
            t.result = { ok: r.ok, text: r.text };
        }
      }
    }
    for (const r of await lines(p.turn(turn, TURN_FILES.prompts))) {
      const k = key(turn, r.id);
      if (r.op === 'prompt' && !prompts.has(k)) {
        if (validateMessage('daemon-to-postbox', { type: 'prompt', id: r.id, turn, request: r.request }).ok) {
          const at = Number.isSafeInteger(r.at) && r.at >= 0 ? r.at : now();
          prompts.set(k, { turn, id: r.id, request: r.request, answer: null, over: false, at, replayed: true });
        }
      } else if (r.op === 'answer') {
        const q = prompts.get(k);
        if (q && validateMessage('daemon-to-shim', { type: 'permission-answer', id: r.id, result: r.result }).ok) q.answer = r.result;
      } else if (r.op === 'expired') {
        prompts.delete(k);
        const reason = r.reason === CANCELED ? CANCELED : 'expired';
        if (Number.isSafeInteger(r.at) && r.at >= 0) expiries.set(k, { turn, id: r.id, at: r.at, reason });
      } else if (r.op === 'expiry-sent' || r.op === 'codex-answered') {
        expiries.delete(k);
        codexHeard.add(k);
      } else if (r.op === 'codex' && Number.isSafeInteger(r.at)) codexSeen.set(k, r.at);
    }
  }

  // ── Codex approvals ──

  /** Starts reading a held Codex turn’s logs, if it is one. @param {string} turn */
  async function watchCodex(turn) {
    if (closed || watches.has(turn)) return;
    const start = await startOf(turn);
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
    watches.set(turn, w);
    await pollCodex(w);
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

  /** @param {CodexWatch} w */
  async function pollCodex(w) {
    w.timer = null;
    if (closed || watches.get(w.turn) !== w || w.busy) return;
    w.busy = true;
    try {
      const over = await ended(w.turn);
      await readOn(p.turn(w.turn, TURN_FILES.out), w.out, (l) => fromCodex(w, l));
      await readOn(p.turn(w.turn, TURN_FILES.in), w.in, (l) => toCodex(w, l));
      if (over) {
        watches.delete(w.turn);
        return;
      }
      const limit = waitMax();
      for (const [k, req] of [...w.pending]) if (now() - req.seen >= limit) await decline(w, k, req, limit);
    } catch (e) {
      log(`Reading turn ${w.turn}’s Codex logs failed: ${e.stack ?? e.message}`);
    } finally {
      w.busy = false;
    }
    if (!closed && watches.get(w.turn) === w) w.timer = timers.setTimeout(() => pollCodex(w), codexPollMs);
  }

  const parse = (l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  /** A line of the app-server’s stdout: an approval request, or the end of the turn that asked. @param {CodexWatch} w @param {string} l */
  function fromCodex(w, l) {
    if (!l.includes('method')) return;
    const msg = parse(l);
    if (!msg || typeof msg.method !== 'string') return;
    if (msg.id != null && Object.hasOwn(CODEX_DECLINE, msg.method)) {
      const k = JSON.stringify(msg.id);
      if (w.requests.has(k) || w.settled.has(k)) return;
      const id = codexPromptId(msg.id);
      const rk = id ? key(w.turn, id) : null;
      const seen = (rk ? codexSeen.get(rk) : undefined) ?? now();
      /** @type {CodexRequest} */
      const req = { rpcId: msg.id, method: msg.method, id, seen };
      w.requests.set(k, req);
      w.pending.set(k, req);
      if (rk && !codexSeen.has(rk)) {
        codexSeen.set(rk, seen);
        note(w.turn, 'prompts', { op: 'codex', id, at: seen });
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
   * @param {CodexWatch} w @param {string} l
   */
  function toCodex(w, l) {
    const msg = response(l);
    if (!msg) return;
    const k = JSON.stringify(msg.id);
    w.pending.delete(k);
    if (w.settled.has(k)) return;
    w.settled.add(k);
    if (w.answering.has(k) || w.tried.has(k)) return;
    const req = w.requests.get(k);
    if (!req?.id || codexHeard.has(key(w.turn, req.id)) || msg.error !== undefined) return;
    if (JSON.stringify(msg.result) !== JSON.stringify(CODEX_DECLINE[/** @type {keyof typeof CODEX_DECLINE} */ (req.method)])) return;
    w.declined.add(k);
    sendExpiry({ turn: w.turn, id: req.id, at: now(), reason: 'expired' });
  }

  /**
   * Declines a request nobody answered: on the held stdin first, and only once the runner has taken the line (it’s in
   * in.jsonl) is it settled and Postbox told. While it’s on its way a `write` from Postbox for it is refused
   * (checkWrite); one the runner didn’t take leaves the request waiting for the next look, and Postbox hears nothing.
   * @param {CodexWatch} w @param {string} k @param {CodexRequest} req @param {number} limit
   */
  async function decline(w, k, req, limit) {
    if (w.answering.has(k) || w.settled.has(k)) return;
    w.pending.delete(k);
    w.answering.set(k, 'decline');
    try {
      await writeStdin(w.turn, codexDeclineLine(req.method, req.rpcId));
    } catch (e) {
      w.answering.delete(k);
      log(`Couldn’t decline Codex’s request ${k} in turn ${w.turn}: ${e.message}. It’s tried again at the next look.`);
      if (!w.settled.has(k) && watches.get(w.turn) === w) w.pending.set(k, req);
      return;
    }
    w.answering.delete(k);
    w.settled.add(k);
    w.declined.add(k);
    log(`Turn ${w.turn}: nobody answered Codex’s ${req.method} (${k}) within ${Math.round(limit / 60_000)} minutes, so it was declined.`);
    if (req.id) sendExpiry({ turn: w.turn, id: req.id, at: now(), reason: 'expired' });
  }

  /**
   * Before the daemon writes a line to a held stdin for Postbox: a refusal for an answer to a request already
   * answered (in.jsonl has its answer, or a line for it went), or one on its way, or else a function to call with
   * whether the write went. A write that went is noted in prompts.jsonl (codex-answered), so a restart doesn’t take
   * Postbox’s own denial in in.jsonl for the daemon’s decline.
   * @param {string} turn @param {string} line
   * @returns {{ refused: string } | { done: (ok: boolean) => void }}
   */
  function checkWrite(turn, line) {
    const w = watches.get(turn);
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
        if (id) note(turn, 'prompts', { op: 'codex-answered', id });
      },
    };
  }
  /** A response line (no method, an id, a result or an error), parsed, or null. @param {string} line */
  const response = (line) => {
    const msg = parse(line);
    return msg && msg.method === undefined && msg.id != null && ('result' in msg || 'error' in msg) ? msg : null;
  };

  return {
    shim,
    message: onMessage,
    hello: onHello,
    /** Replays every turn folder’s records, and starts watching the held Codex turns still running. @param {{ turn: string, state: string }[]} turns */
    async load(turns) {
      for (const t of turns) await loadTurn(t.turn);
      for (const q of prompts.values()) if (q.replayed && !q.answer) armOrphan(q);
      for (const t of turns) if (t.state === 'running') await watchCodex(t.turn);
    },
    /** Before a turn’s runner starts: its snapshot, sent before `start`, goes into the new folder. @param {string} turn */
    async starting(turn) {
      const snap = pendingSnapshots.get(turn);
      if (snap) await saveSnapshot(turn, snap);
    },
    /** Once a turn’s runner is up. @param {string} turn */
    started: (turn) => watchCodex(turn),
    /**
     * Stop arrived for a turn: its shims are refused from now on, and its prompts can’t be answered.
     * @param {string} turn
     */
    async stopping(turn) {
      if (stopping.has(turn)) return;
      stopping.add(turn);
      // Stopping holds in memory even if it isn’t written down; only a restart would forget it.
      await note(turn, 'tools', { op: 'stopping', id: '-' });
      for (const s of [...(shims.get(turn) ?? [])]) s.send('error', { code: 'turn-ended', message: STOPPED_TEXT });
      await Promise.all([...prompts.values()].filter((q) => q.turn === turn && !q.answer).map((q) => endPrompt(turn, q.id, now(), CANCELED)));
    },
    checkWrite,
    /** Whether a turn is stopping. @param {string} turn */
    isStopping: (turn) => stopping.has(turn),
    close() {
      closed = true;
      for (const w of watches.values()) if (w.timer) timers.clearTimeout(w.timer);
      watches.clear();
      for (const t of orphanTimers) timers.clearTimeout(t);
      orphanTimers.clear();
    },
    /** For tests: what waits. */
    get pending() {
      return {
        tools: [...tools.values()].filter((t) => !t.replied),
        prompts: [...prompts.values()],
        expiries: [...expiries.values()],
        watches: [...watches.keys()],
      };
    },
  };
}
