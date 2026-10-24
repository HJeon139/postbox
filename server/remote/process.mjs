// A turn on a remote host, in spawn’s shape (#120, architecture.md “The adapters stay; only the process moves”). The
// adapters take a spawn function as spawnImpl; remoteSpawn returns one whose child is backed by the host’s daemon
// over a connection, so the stream mappers and the adapters’ stdin, stdout, stderr and exit handling don’t change.
//
// What differs from a local child, on purpose:
// - `bin` is ignored: the daemon runs the program it found for `harness` (or the configured path), and `start.argv` is
//   the arguments without the program (shared/remote-protocol.mjs’s header). opts.env and opts.cwd are ignored too:
//   the laptop’s environment never crosses, only the `env` given to remoteSpawn, which the caller takes from the
//   adapter’s capabilities.remote.env, and the working folder is `folder`, a path on the host.
// - No `pid`, and `remote: true`. A host’s process ID would mean an unrelated process here, so process-group.mjs’s
//   stopTurn, signalGroup and stopJobUnder branch on `remote` and never call the local kill or ps. kill(signal) sends
//   the daemon’s `stop` once, whatever the signal; the daemon sends SIGINT, then SIGKILL (C5). After kill() no `start`
//   goes, not even again at a welcome. One that may have reached the host unconfirmed gets `stop` instead, at each
//   welcome and at its `started` (or turn-exists), since the stop before it may have found no turn there; a no-turn
//   answer to that stop means it never arrived, and the child exits as a kill before start does. One that never
//   reached a channel sends nothing: the child exits at once.
// - `exit` and `close` come from the daemon’s `ended`. An interrupted turn (no live runner and no exit.json) exits
//   with code null and signal null, and sets `interrupted`.
// - A line the daemon had to cut (over REMOTE_LIMITS.streamLineBytes) puts nothing on stdout: the child emits `cut`
//   with its offsets and writes a short note to stderr, so the adapter’s mapper sees the stream go on.
//
// stdin, by the turn’s kind (capabilities.remote.stdin):
// - 'file': what the adapter writes is kept until stdin.end(), then sent in `start` as MESSAGE_FILE (Claude Code writes
//   its one stream-json message, then ends).
// - 'none': `start` goes at once; anything written is dropped, with a note on stderr.
// - 'held': `start` goes at once, and each complete line written is sent as `write`, in order, one at a time: the next
//   goes once the daemon says `written`. stdin.end() sends a last line with no \n, if any; the runner holds the
//   harness’s stdin open until the turn ends, so there’s nothing else to close. The child also reads in.jsonl (`read`
//   with `log: 'in'`) beside out.jsonl, from 0, and emits each of its lines once as 'stdin-line' ({ offset, next,
//   text }): what reached the harness, from Postbox or from the daemon (Codex approval expiry, H4). The Codex adapter
//   rebuilds a turn from it after a Postbox restart, once the child has emitted 'caught-up' ({ log, size }) for both
//   logs: the daemon’s word that a read’s first pass has sent every line the log had.
//
// Reading and acking: after `started`, the child sends `read { turn, from }` and keeps `next`, the offset just past the
// last line it applied (pushed to stdout, or cut). A line’s offset is its identity, so one whose offset is below `next`
// is a repeat and is dropped: a line is applied once however often it’s read. It acks `next` after ACK_LINES lines, or
// ACK_MS after the first line not yet acked, whichever comes first, and once more at `ended`, so the daemon can delete
// what Postbox has (H5) without an ack per line.
//
// Replay after a Postbox restart: attachRemote (or remoteSpawn with `attach`) skips `start` and reads an existing turn,
// from offset 0 by default, so the adapter’s fresh mapper gets the whole stream.
//
// The connection (L1, server/remote/ssh.mjs, built against this):
// - send(msg): msg is a postbox-to-daemon message, already built with shared/remote-protocol.mjs’s message(). Returns
//   true once it’s written to a channel that has had its welcome, false while there’s none (before the first welcome,
//   or between a drop and the next). It doesn’t throw for a dropped connection.
// - 'message' (msg): each daemon-to-postbox message after the welcome, validated. Every turn’s child listens and keeps
//   only its own, so the connection should lift EventEmitter’s listener limit (setMaxListeners(0)).
// - 'connected' (): a channel has said hello and got its welcome: the first, and each one after a drop. The child then
//   sends what didn’t reach the daemon, and `read` from `next` once its turn has started. So a child made before the
//   first welcome starts at it, and one that was reading picks up where it left off.
// - 'error' (err): the connection has given up, and no more messages will come. The child emits it as its own
//   'error', then exits with code null and signal null (not `interrupted`: the turn may still run on the host, for a
//   later attach to replay).
// A `write` sent just before a drop, whose `written` never came, may or may not have reached the runner. Sending it again
// blindly could apply a JSON-RPC line twice (a second thread/start), and dropping it could leave the harness waiting
// for it, so after the reconnect the child looks for it in in.jsonl and sends it again only if it isn’t there. Two
// reads decide, handled in order on the channel: `base` is in.jsonl’s size when the line was sent (the larger of the
// last `written` and the end of the in.jsonl lines seen), and `end` is base plus the line and its \n.
// - `read { log: 'in', from: end }` fails with bad-offset unless end is the file’s size or a line’s start. A failure
//   means the line isn’t there: it’s sent again.
// - `read { log: 'in', from: base }` then reads in.jsonl again from base. The line itself means it arrived; a line
//   ending at `end` that isn’t it means it didn’t (the first read passed only because another writer’s line, an
//   expiry, ended there), and it’s sent again.
// One of the two always decides, so the next line never waits for good. A write still under way from the dropped
// channel when the reads arrive could still land twice; the window is the runner’s one append, against a reconnect.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { MESSAGE_FILE } from '../../shared/remote-protocol.mjs';
import { apply, applyIn, handle, onDaemonError, onStarted, settle } from './process-receive.mjs';
import { ack, build, pump, read, resume, send, sendStart, startFiles } from './process-send.mjs';
import { makeStdin } from './process-stdin.mjs';

export { ACK_LINES, ACK_MS } from './process-receive.mjs';

/**
 * @typedef {{ send: (msg: object) => boolean } & import('node:events').EventEmitter} RemoteConnection
 * @typedef {'file' | 'none' | 'held'} StdinKind
 * @typedef {{ name: string, text: string }} TurnFile
 * @typedef {{ name: string, text: string }} AgentFile
 * @typedef {{ name: string, base64: string }} Attachment
 */

/**
 * A spawn function for one remote turn, to pass as an adapter’s spawnImpl. Each call starts a turn on the host; `turn`
 * names the first one (the caller keeps it, to attach after a restart), and a later call gets a fresh ID, read from
 * the child’s `turn`. With `attach`, each call reads an existing turn instead and sends no `start`. agentFile goes in
 * `start` as it is (a Kiro CLI custom agent, which the daemon writes into the agents folder of the Kiro home the
 * runner will use, from env’s KIRO_HOME, the host’s own, or ~/.kiro, rather than the turn folder). attachments go in
 * every start as they are (the message’s files, which the daemon writes under the turn folder’s attachments/), so a
 * later call carries them again.
 * @param {{ connection: RemoteConnection, harness: import('../../shared/remote-protocol.mjs').Harness, folder: string,
 *           stdin: StdinKind, env?: Record<string, string>, files?: TurnFile[], agentFile?: AgentFile, turn?: string,
 *           attach?: { from?: number }, attachments?: Attachment[] }} o
 * @returns {(bin: string, args?: readonly string[], opts?: object) => RemoteProcess}
 */
export function remoteSpawn({ connection, harness, folder, stdin, env = {}, files = [], agentFile, turn, attach, attachments = [] }) {
  let first = turn;
  return (_bin, args = [], _opts) => {
    const id = first ?? randomUUID();
    first = undefined;
    if (attach) return attachRemote(connection, { turn: id, from: attach.from ?? 0, stdin });
    const agent = agentFile ? { agentFile: { ...agentFile } } : {};
    const carried = attachments.length ? { attachments: attachments.map((x) => ({ ...x })) } : {};
    const start = { harness, folder, argv: [...args], env: { ...env }, stdin, files: [...files], ...agent, ...carried };
    return new RemoteProcess(connection, { turn: id, start });
  };
}

/**
 * A turn that’s already on the host, read from `from` (0 by default, for a fresh mapper after a Postbox restart). No
 * `start` is sent. A held stdin still forwards lines.
 * @param {RemoteConnection} connection @param {{ turn: string, from?: number, stdin?: StdinKind }} o
 */
export function attachRemote(connection, { turn, from = 0, stdin = 'none' }) {
  return new RemoteProcess(connection, { turn, from, stdin });
}

/** The child remoteSpawn and attachRemote return. */
export class RemoteProcess extends EventEmitter {
  /**
   * @param {RemoteConnection} connection
   * @param {{ turn: string, start?: { harness: string, folder: string, argv: string[], env: Record<string, string>, stdin: StdinKind,
   *           files: TurnFile[], agentFile?: AgentFile, attachments?: Attachment[] }, from?: number, stdin?: StdinKind }} o  start for a new turn, or
   *   from to attach to one
   */
  constructor(connection, { turn, start, from = 0, stdin }) {
    super();
    /** Marks this child as remote, for process-group.mjs. It has no `pid`. */
    this.remote = true;
    this.turn = turn;
    /** @type {number | null} */
    this.exitCode = null;
    /** @type {string | null} */
    this.signalCode = null;
    this.killed = false;
    /** The daemon found no live runner and no exit.json: the turn ended without saying how. */
    this.interrupted = false;
    /** `exit` has been emitted. */
    this.ended = false;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.conn = connection;
    this.kind = start?.stdin ?? stdin ?? 'none';
    this.startBody = start ? { turn, ...start } : null;
    checkStart(this);
    /** `start` was handed to the connection (or isn’t needed). */
    this.startSent = !start;
    /** `start` was written to a channel that had its welcome, so it may be on the host (or isn’t needed). */
    this.startWritten = !start;
    this.startResent = false;
    this.started = !start;
    this.next = from;
    this.acked = from;
    this.unacked = 0;
    /** @type {NodeJS.Timeout | null} */
    this.ackTimer = null;
    this.stopSent = false;
    this.stopPending = false;
    /** @type {string[]} */
    this.queue = [];
    /** @type {{ line: string, sent: boolean, base: number } | null} */
    this.inFlight = null;
    /** For a held stdin: in.jsonl’s size at the last `written`, and the offset past the last in.jsonl line emitted. */
    this.inUpTo = 0;
    this.inNext = 0;
    /** A line lost in a drop, being looked for in in.jsonl (the header), with where it would end. */
    /** @type {{ line: string, base: number, end: number } | null} */
    this.checking = null;
    this.stdin = this.makeStdin();
    this.onMessage = (m) => this.handle(m);
    this.onConnected = () => this.resume();
    this.onError = (e) => this.fail(e instanceof Error ? e : new Error(String(e)));
    begin(this, connection, start);
  }

  /**
   * Sends the daemon’s `stop`, once, and never a `start` from here on. False if the turn has already ended. A start
   * that may have reached the host but isn’t confirmed is stopped again at each welcome and at its `started` (the
   * header). @param {string} [_signal]  any: the daemon decides
   */
  kill(_signal) {
    if (this.ended) return false;
    this.killed = true;
    if (!this.startWritten) {
      // Nothing is on the host yet (a file stdin not ended, spawn just returned, or no channel had its welcome when
      // start went): there’s nothing to stop there.
      this.startBody = null;
      this.finish({ code: null, signal: 'SIGINT' });
      return true;
    }
    if (this.stopSent) return true;
    this.stopSent = true;
    this.stopPending = !this.send('stop', { turn: this.turn });
    return true;
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────

  build(type, body) {
    return build(this, type, body);
  }

  send(type, body) {
    return send(this, type, body);
  }

  startFiles(text) {
    return startFiles(this, text);
  }

  sendStart(body) {
    return sendStart(this, body);
  }

  read() {
    return read(this);
  }

  ack() {
    return ack(this);
  }

  pump() {
    return pump(this);
  }

  resume() {
    return resume(this);
  }

  // ── Receiving ───────────────────────────────────────────────────────────────────────

  handle(m) {
    return handle(this, m);
  }

  onStarted() {
    return onStarted(this);
  }

  apply(m) {
    return apply(this, m);
  }

  applyIn(m) {
    return applyIn(this, m);
  }

  settle(arrived) {
    return settle(this, arrived);
  }

  onDaemonError(m) {
    return onDaemonError(this, m);
  }

  // ── Ending ──────────────────────────────────────────────────────────────────────────

  /** @param {string} text */
  note(text) {
    if (!this.ended) this.stderr.push(`Postbox: ${text}\n`);
  }

  /** @param {Error & { code?: string }} e */
  fail(e) {
    if (this.ended) return;
    this.emit('error', e);
    this.finish({ code: null, signal: null }, { lost: true });
  }

  /**
   * exit, then close once stdout and stderr have ended, as a local child’s close waits for its stdio.
   * @param {{ code: number | null, signal: string | null } | null} exit  null: interrupted
   * @param {{ lost?: boolean }} [o]  lost: the connection failed, which isn’t the turn’s end on the host
   */
  finish(exit, { lost = false } = {}) {
    if (this.ended) return;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.ended = true;
    this.interrupted = exit === null && !lost;
    this.exitCode = exit?.code ?? null;
    this.signalCode = exit?.signal ?? null;
    this.queue = [];
    this.conn.off('message', this.onMessage);
    this.conn.off('connected', this.onConnected);
    this.conn.off('error', this.onError);
    const ends = [this.stdout, this.stderr].map(
      (s) =>
        new Promise((resolve) => {
          s.once('end', resolve);
          s.push(null);
          // Nobody reads it: let it drain, so close still comes.
          if (s.readableFlowing === null) s.resume();
        }),
    );
    this.emit('exit', this.exitCode, this.signalCode);
    Promise.all(ends).then(() => this.emit('close', this.exitCode, this.signalCode));
  }

  makeStdin() {
    return makeStdin(this);
  }
}

/**
 * Checks a new turn’s start now, as spawn checks its arguments, so a bad argv or env throws where the adapter calls
 * spawn. The message file isn’t written yet; its size is checked again when it is.
 * @param {RemoteProcess} p
 */
function checkStart(p) {
  if (p.startBody?.stdin === 'file' && p.startBody.files.some((f) => f.name === MESSAGE_FILE))
    throw new TypeError(`A turn with a file stdin gets ${MESSAGE_FILE} from what’s written to stdin, so files can’t carry one.`);
  if (p.startBody) p.build('start', p.startFiles(''));
}

/** Listens to the connection, then starts or reads the turn. @param {RemoteProcess} p @param {RemoteConnection} connection @param {object} [start] */
function begin(p, connection, start) {
  connection.on('message', p.onMessage);
  connection.on('connected', p.onConnected);
  connection.on('error', p.onError);
  // After spawn returns, as a local child’s events come, so the adapter has its listeners on first.
  process.nextTick(() => {
    if (p.ended) return;
    if (!start) p.read();
    else if (p.kind !== 'file') p.sendStart(p.startFiles(null));
  });
}
