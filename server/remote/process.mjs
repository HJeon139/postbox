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
//   the daemon’s `stop` once, whatever the signal; the daemon sends SIGINT, then SIGKILL (C5).
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
//   harness’s stdin open until the turn ends, so there’s nothing else to close.
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
// A `write` sent just before a drop may or may not have reached the runner, and isn’t resent, so a JSON-RPC line is
// never applied twice; the child says so on stderr. L4c’s rebuild from in.jsonl is what recovers from that.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { MESSAGE_FILE, message } from '../../shared/remote-protocol.mjs';

/** Lines applied before an ack goes, at most. */
export const ACK_LINES = 64;
/** How long the first line not yet acked waits for its ack, at most. */
export const ACK_MS = 250;

/**
 * @typedef {{ send: (msg: object) => boolean } & import('node:events').EventEmitter} RemoteConnection
 * @typedef {'file' | 'none' | 'held'} StdinKind
 * @typedef {{ name: string, text: string }} TurnFile
 */

/**
 * A spawn function for one remote turn, to pass as an adapter’s spawnImpl. Each call starts a turn on the host; `turn`
 * names the first one (the caller keeps it, to attach after a restart), and a later call gets a fresh ID, read from
 * the child’s `turn`. With `attach`, each call reads an existing turn instead and sends no `start`.
 * @param {{ connection: RemoteConnection, harness: import('../../shared/remote-protocol.mjs').Harness, folder: string,
 *           stdin: StdinKind, env?: Record<string, string>, files?: TurnFile[], turn?: string, attach?: { from?: number } }} o
 * @returns {(bin: string, args?: readonly string[], opts?: object) => RemoteProcess}
 */
export function remoteSpawn({ connection, harness, folder, stdin, env = {}, files = [], turn, attach }) {
  let first = turn;
  return (_bin, args = [], _opts) => {
    const id = first ?? randomUUID();
    first = undefined;
    if (attach) return attachRemote(connection, { turn: id, from: attach.from ?? 0, stdin });
    return new RemoteProcess(connection, { turn: id, start: { harness, folder, argv: [...args], env: { ...env }, stdin, files: [...files] } });
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
   *           files: TurnFile[] }, from?: number, stdin?: StdinKind }} o  start for a new turn, or from to attach to one
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
    if (this.startBody?.stdin === 'file' && this.startBody.files.some((f) => f.name === MESSAGE_FILE))
      throw new TypeError(`A turn with a file stdin gets ${MESSAGE_FILE} from what’s written to stdin, so files can’t carry one.`);
    // Checked now, as spawn checks its arguments, so a bad argv or env throws where the adapter calls spawn. The
    // message file isn’t written yet; its size is checked again when it is.
    if (this.startBody) this.build('start', this.startFiles(''));
    /** `start` was handed to the connection (or isn’t needed). */
    this.startSent = !start;
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
    /** @type {{ line: string, sent: boolean } | null} */
    this.inFlight = null;
    this.stdin = this.makeStdin();
    this.onMessage = (m) => this.handle(m);
    this.onConnected = () => this.resume();
    this.onError = (e) => this.fail(e instanceof Error ? e : new Error(String(e)));
    connection.on('message', this.onMessage);
    connection.on('connected', this.onConnected);
    connection.on('error', this.onError);
    // After spawn returns, as a local child’s events come, so the adapter has its listeners on first.
    process.nextTick(() => {
      if (this.ended) return;
      if (!start) this.read();
      else if (this.kind !== 'file') this.sendStart(this.startFiles(null));
    });
  }

  /** Sends the daemon’s `stop`, once. False if the turn has already ended. @param {string} [_signal]  any: the daemon decides */
  kill(_signal) {
    if (this.ended) return false;
    this.killed = true;
    if (!this.startSent) {
      // Nothing is on the host yet (a file stdin not ended, or spawn just returned): there’s nothing to stop there.
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

  /** @param {string} type @param {Record<string, unknown>} body */
  build(type, body) {
    return message('postbox-to-daemon', type, body);
  }

  /** @param {string} type @param {Record<string, unknown>} body */
  send(type, body) {
    return this.conn.send(this.build(type, body)) === true;
  }

  /** start’s files: the caller’s, and for a file stdin the message. @param {string | null} text */
  startFiles(text) {
    const b = /** @type {NonNullable<typeof this.startBody>} */ (this.startBody);
    return { ...b, files: b.stdin === 'file' ? [...b.files, { name: MESSAGE_FILE, text: text ?? '' }] : b.files };
  }

  /** @param {Record<string, unknown>} body */
  sendStart(body) {
    if (this.ended || !this.startBody) return;
    let msg;
    try {
      msg = this.build('start', body);
    } catch (e) {
      return this.fail(e);
    }
    this.startBody = /** @type {any} */ (body);
    this.startSent = true;
    // Unsent, it goes at the next welcome, as one that may have been lost in a drop does.
    this.conn.send(msg);
    this.pump();
  }

  read() {
    if (this.ended) return;
    // Unsent, it goes at the next welcome.
    this.send('read', { turn: this.turn, from: this.next });
  }

  ack() {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.unacked = 0;
    if (this.next > this.acked && this.send('ack', { turn: this.turn, upTo: this.next })) this.acked = this.next;
  }

  /** The next held-stdin line, once the one before it is written. */
  pump() {
    while (!this.ended && this.startSent && !this.inFlight && this.queue.length) {
      const line = /** @type {string} */ (this.queue.shift());
      let msg;
      try {
        msg = this.build('write', { turn: this.turn, line });
      } catch (e) {
        this.note(`A line for the agent’s stdin couldn’t be sent, so it was dropped: ${e.message}`);
        continue;
      }
      this.inFlight = { line, sent: this.conn.send(msg) === true };
    }
  }

  /** Whatever didn’t reach the daemon, at a welcome. */
  resume() {
    if (this.ended) return;
    if (this.stopPending) this.stopPending = !this.send('stop', { turn: this.turn });
    if (this.startSent && !this.started && this.startBody) {
      // It may have reached the daemon before the drop: a turn-exists answer then means it did.
      this.startResent = true;
      this.conn.send(this.build('start', this.startBody));
    }
    if (this.inFlight?.sent) {
      this.note('The connection to the host dropped while a line for the agent’s stdin was on its way; it may not have arrived.');
      this.inFlight = null;
    } else if (this.inFlight) {
      this.queue.unshift(this.inFlight.line);
      this.inFlight = null;
    }
    this.pump();
    if (this.started) {
      this.read();
      if (this.next > this.acked) this.ack();
    }
  }

  // ── Receiving ───────────────────────────────────────────────────────────────────────

  /** @param {any} m */
  handle(m) {
    if (this.ended || m?.turn !== this.turn) return;
    switch (m.type) {
      case 'started':
        return this.onStarted();
      case 'line':
        return m.log === 'in' ? undefined : this.apply(m);
      case 'written':
        this.inFlight = null;
        return this.pump();
      case 'ended':
        this.ack();
        return this.finish(m.exit);
      case 'error':
        return this.onDaemonError(m);
    }
  }

  onStarted() {
    if (this.started) return;
    this.started = true;
    this.read();
  }

  /** @param {{ offset: number, next: number, text: string, cut?: boolean }} m */
  apply(m) {
    if (m.offset < this.next) return; // already applied: its offset is its identity
    if (m.cut) {
      this.emit('cut', { offset: m.offset, next: m.next });
      this.note(`A line of the agent’s output at byte ${m.offset} was too long to send from the host, so it was left out.`);
    } else this.stdout.push(`${m.text}\n`);
    this.next = m.next;
    if (++this.unacked >= ACK_LINES) this.ack();
    else if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => this.ack(), ACK_MS);
      this.ackTimer.unref?.();
    }
  }

  /** @param {{ code: string, message: string, re?: string }} m */
  onDaemonError(m) {
    if (m.re === 'start') {
      if (m.code === 'turn-exists' && this.startResent) return this.onStarted();
      return this.fail(Object.assign(new Error(m.message), { code: m.code }));
    }
    if (m.re === 'read') return this.fail(Object.assign(new Error(m.message), { code: m.code }));
    if (m.re === 'write') {
      this.note(`A line for the agent’s stdin wasn’t written on the host: ${m.message}`);
      this.inFlight = null;
      if (m.code === 'turn-ended') this.queue = [];
      return this.pump();
    }
    // A refused ack or stop changes nothing: the turn’s end still comes as `ended`.
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
    if (this.kind === 'file') {
      /** @type {Buffer[]} */
      const chunks = [];
      return new Writable({
        write: (chunk, _enc, cb) => {
          chunks.push(Buffer.from(chunk));
          cb();
        },
        final: (cb) => {
          cb();
          if (!this.startSent && this.startBody) this.sendStart(this.startFiles(Buffer.concat(chunks).toString('utf8')));
        },
      });
    }
    if (this.kind === 'held') {
      let partial = '';
      const decoder = new TextDecoder();
      const take = (/** @type {string} */ text) => {
        const parts = (partial + text).split('\n');
        partial = /** @type {string} */ (parts.pop());
        this.queue.push(...parts);
        this.pump();
      };
      return new Writable({
        write: (chunk, _enc, cb) => {
          take(decoder.decode(chunk, { stream: true }));
          cb();
        },
        final: (cb) => {
          take(decoder.decode());
          if (partial) this.queue.push(partial);
          partial = '';
          this.pump();
          cb();
        },
      });
    }
    let told = false;
    return new Writable({
      write: (_chunk, _enc, cb) => {
        if (!told) this.note('This turn’s agent takes no stdin, so what was written to it was dropped.');
        told = true;
        cb();
      },
    });
  }
}
