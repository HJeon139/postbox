// Cleanup on a remote host (#120, the design’s “Files and cleanup”): what the daemon deletes, and when. Everything it
// deletes is under ~/.postbox-remote, except a Kiro agent file a turn’s start.agentFile put outside it, which goes
// only if it still holds the text the daemon wrote.
//
// - Acks persist. Postbox’s `ack` for a turn is kept in the turn folder’s `.ack` (the offset, 0600, written atomically),
//   so a restarted daemon still knows what Postbox has applied. A file name that starts with a dot is one Postbox can’t
//   send in start.files, so it never collides with one.
// - A turn’s logs (out.jsonl, in.jsonl, err.log) are deleted once it has ended (exit.json) and Postbox has acked all of
//   out.jsonl. The protocol acks out.jsonl only; in.jsonl holds Postbox’s own writes, each confirmed by `written`, and
//   matters only for rebuilding a Codex turn that’s still running, so it goes with out.jsonl. `.ack` stays, holding
//   out.jsonl’s size, so welcome.turns and a `read` still answer for the turn.
// - The turn’s other files go when it ends: the message, the snapshot, any other file start.files carried, and the
//   agent file. exit.json, runner.json, start.json and `.ack` stay, as do prompts.jsonl and tools.jsonl (the broker’s
//   queue for Postbox, which may still owe a reply after the turn ends), until the folder goes.
// - A turn folder whose newest file is older than logRetention is deleted whole, acked or not, unless its runner is
//   still running: the runner holds its logs open, and it’s still Postbox’s turn.
// - A log over logMaxBytes. For a running turn, out.jsonl and in.jsonl can’t be cut safely: Postbox addresses lines by
//   byte offset, so truncating would point every offset it holds at other bytes, and deleting a file the harness still
//   has open frees no space until the harness exits. The runner can’t be told to stop writing, either. So the daemon
//   stops the turn, as Stop does, and says why (the log, err.log, and Postbox’s `error`, `internal`, for the turn): a
//   turn that writes that much is broken, and stopping it bounds the disk. Once ended, the log follows the rules above;
//   Postbox may still read what it hasn’t. err.log is different: Postbox never reads it, and the runner opens it
//   O_APPEND, so writes after a truncation land at its new end. One over the cap is emptied, with a line saying so.
// - Versions retire. An older version’s code folder (~/.postbox-remote/<old>/) is deleted by the newest version’s
//   daemon once no turn that version started (runner.json.version) is running, no daemon of it holds daemon.pid, and
//   no attach or install of it holds its start lock (~/.postbox-remote/locks/<old>.lock, hostPaths().lock): one whose
//   owner record names a live process, whatever its age, or one with no record yet, younger than LOCK_FRESH_MS (proc.mjs,
//   “The start lock’s owner”).
// - `remove` deletes ~/.postbox-remote whole, after the daemon has stopped the turns, only if it’s a folder (not a
//   link) whose real path is the real home folder’s .postbox-remote.
//
// Every step runs one at a time (a queue), so an ack and a sweep never race over the same turn. Nothing here follows
// a link: a turn folder that’s a link is skipped, and files are unlinked, never removed recursively, inside one.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { DIR_MODE, FILE_MODE, hostPaths, REMOTE_DIR, TURN_FILES, validateRunnerRecord } from '../../../shared/remote-protocol.mjs';
import { LOCK_OWNER, lockOwnerLive, parseLockOwner } from './proc.mjs';

/** Where a turn’s ack is kept: Postbox’s `ack.upTo`, as decimal text. */
export const ACK_FILE = '.ack';
/** Where a turn’s agent file is recorded: { path, sha256 } of what the daemon wrote. */
export const AGENT_RECORD = '.agent-file.json';
/** How often the daemon sweeps: turns, caps and old versions. */
export const SWEEP_MS = 60_000;
/** A folder with no runner.json yet, younger than this, may be a turn the daemon is starting. */
export const START_GRACE_MS = 60_000;
/** A start lock with no owner record yet, younger than this, is one an attach or install just made (daemon.mjs’s LOCK_STALE_MS). */
export const LOCK_FRESH_MS = 30_000;

/** A turn folder’s files that stay once the turn has ended, until the folder goes. */
const KEEP = new Set([
  TURN_FILES.out,
  TURN_FILES.in,
  TURN_FILES.err,
  TURN_FILES.exit,
  TURN_FILES.runner,
  TURN_FILES.start,
  TURN_FILES.prompts,
  TURN_FILES.tools,
  ACK_FILE,
  AGENT_RECORD,
]);
const LOGS = [TURN_FILES.out, TURN_FILES.in, TURN_FILES.err];
/** An installed version’s folder name (paths.mjs’s rule). */
const INSTALLED = /^\d+\.\d+\.\d+$/;

/** @typedef {'running' | 'starting' | 'ended' | 'interrupted'} TurnState */
/**
 * What a sweep did, for the log and the tests.
 * @typedef {{ folders: string[], logs: string[], capped: string[], emptied: string[], retired: string[], skipped: string[] }} Swept
 */

/** Compares two installed versions, such as 0.9.0 and 0.10.0. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const sha256 = (/** @type {string | Buffer} */ v) => createHash('sha256').update(v).digest('hex');

/**
 * The cleanup for one daemon. `stopTurn` is the daemon’s Stop without a connection; `onCap` tells Postbox a turn was
 * stopped at the cap.
 * @param {{ home: string, version: string, paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>,
 *   now?: () => number, log?: (line: string) => void,
 *   settings: () => { logRetention: number, logMaxBytes: number },
 *   sameProcess: (r: { pid: number, bootId: string, startTime: number }) => boolean | Promise<boolean>,
 *   stopTurn?: (turn: string) => Promise<unknown>, onCap?: (turn: string, text: string) => void }} o
 */
export function createCleanup({ home, version, paths: p, now = Date.now, log = () => {}, settings, sameProcess, stopTurn = async () => {}, onCap = () => {} }) {
  let ids = 0;
  /** Turns stopped at the cap, so each is stopped once. */
  const capped = new Set();
  /** Turn folders already said to be links, so the log says it once. */
  const linked = new Set();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** Runs one step after the others. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const lstat = (path) => fsp.lstat(path).catch(() => null);
  const sizeOf = async (path) => (await lstat(path))?.size ?? 0;
  const readJson = async (path) => {
    try {
      return JSON.parse(await fsp.readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  };
  /** Unlinks a file; one that’s already gone is fine. */
  const unlink = (path) =>
    fsp.unlink(path).catch((e) => {
      if (e.code !== 'ENOENT') log(`Couldn’t delete ${path}: ${e.message}`);
    });
  const writeAtomic = async (path, text) => {
    const tmp = `${path}.${process.pid}.${++ids}.tmp`;
    await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
    await fsp.rename(tmp, path);
  };

  /** A turn’s folder, if it’s a real folder under turns/ (not a link, and a turn ID). @param {string} turn */
  async function turnDir(turn) {
    let dir;
    try {
      dir = p.turn(turn);
    } catch {
      return null;
    }
    const st = await lstat(dir);
    if (!st) return null;
    if (!st.isDirectory()) {
      if (st.isSymbolicLink() && !linked.has(turn)) {
        linked.add(turn);
        log(`${dir} is a link, not a folder, so cleanup leaves it alone.`);
      }
      return null;
    }
    return dir;
  }

  /** The newest change in a folder: its own and each entry’s mtime. @param {string} dir */
  async function newest(dir) {
    let t = (await lstat(dir))?.mtimeMs ?? 0;
    for (const name of await fsp.readdir(dir).catch(() => [])) t = Math.max(t, (await lstat(`${dir}/${name}`))?.mtimeMs ?? 0);
    return t;
  }

  /** @param {string} dir @returns {Promise<{ state: TurnState, version: string | null }>} */
  async function stateOf(dir) {
    if (await lstat(`${dir}/${TURN_FILES.exit}`)) return { state: 'ended', version: null };
    const rec = validateRunnerRecord(await readJson(`${dir}/${TURN_FILES.runner}`));
    if (rec.ok) return { state: (await sameProcess(rec.msg)) ? 'running' : 'interrupted', version: rec.msg.version };
    // No runner.json yet: a turn being started, or one whose runner never got going.
    return { state: now() - (await newest(dir)) < START_GRACE_MS ? 'starting' : 'interrupted', version: null };
  }

  // ── Acks ──

  /** The offset Postbox has acked for a turn, or null if it never has. @param {string} turn */
  async function readAck(turn) {
    try {
      const text = await fsp.readFile(p.turn(turn, ACK_FILE), 'utf8');
      return /^\d{1,16}\n?$/.test(text) ? Number(text.trim()) : null;
    } catch {
      return null;
    }
  }

  // ── The agent file ──

  /**
   * Removes the agent file a turn wrote, if it still holds what was written (by its hash), then the record. No other
   * turn shares it: writeAgentFile never writes over a file that’s there.
   * @param {string} turn @param {string} dir
   */
  async function dropAgentFile(turn, dir) {
    const rec = await readJson(`${dir}/${AGENT_RECORD}`);
    if (!rec || typeof rec.path !== 'string' || !rec.path.startsWith('/') || !rec.path.endsWith('.json') || typeof rec.sha256 !== 'string') {
      if (rec !== undefined) await unlink(`${dir}/${AGENT_RECORD}`);
      return;
    }
    const st = await lstat(rec.path);
    if (st?.isFile()) {
      const text = await fsp.readFile(rec.path).catch(() => null);
      if (text && sha256(text) === rec.sha256) await unlink(rec.path);
      else log(`Turn ${turn}’s agent file ${rec.path} has changed since the daemon wrote it, so it stays.`);
    }
    await unlink(`${dir}/${AGENT_RECORD}`);
  }

  // ── A turn ──

  /**
   * One turn’s cleanup: its files at the end, its logs once acked, the cap, and its folder past logRetention.
   * @param {string} turn @param {Swept} done
   * @returns {Promise<{ state: TurnState, version: string | null } | null>}
   */
  async function tidy(turn, done) {
    const dir = await turnDir(turn);
    if (!dir) return null;
    const st = await stateOf(dir);
    const { logRetention, logMaxBytes } = settings();
    if (st.state !== 'running' && st.state !== 'starting' && now() - (await newest(dir)) > logRetention) {
      await dropAgentFile(turn, dir);
      await fsp.rm(dir, { recursive: true, force: true });
      capped.delete(turn);
      done.folders.push(turn);
      log(`Deleted turn ${turn}’s folder: nothing in it changed for ${Math.round(logRetention / 3_600_000)} h (logRetention).`);
      return st;
    }
    // err.log over the cap, in any state: emptied, since nothing reads it by offset.
    const err = `${dir}/${TURN_FILES.err}`;
    const errSize = await sizeOf(err);
    if (errSize > logMaxBytes) {
      await fsp.truncate(err, 0).catch((e) => log(`Couldn’t empty ${err}: ${e.message}`));
      await fsp.appendFile(err, `postbox daemon: err.log passed logMaxBytes (${logMaxBytes} bytes) at ${errSize} bytes and was emptied.\n`, {
        mode: FILE_MODE,
      });
      done.emptied.push(turn);
    }
    if (st.state === 'running') {
      const over = [];
      for (const f of [TURN_FILES.out, TURN_FILES.in]) {
        const size = await sizeOf(`${dir}/${f}`);
        if (size > logMaxBytes) over.push(`${f} is ${size} bytes`);
      }
      if (over.length && !capped.has(turn)) {
        capped.add(turn);
        const text = `Turn ${turn} was stopped: ${over.join(' and ')}, over this host’s logMaxBytes (${logMaxBytes} bytes). A log can’t be cut while the turn writes it.`;
        log(text);
        await fsp.appendFile(err, `postbox daemon: ${text}\n`, { mode: FILE_MODE }).catch(() => {});
        await stopTurn(turn);
        onCap(turn, text);
        done.capped.push(turn);
      }
      return st;
    }
    if (st.state !== 'ended') return st;
    // Ended: the turn’s own files go.
    await dropAgentFile(turn, dir);
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      // A .tmp is a file being written whole (a snapshot that came late, say); it’s left to the folder’s retention.
      if (KEEP.has(name) || name.endsWith('.tmp')) continue;
      const f = await lstat(`${dir}/${name}`);
      if (f && !f.isDirectory()) await unlink(`${dir}/${name}`);
    }
    // And its logs, once Postbox has acked all of out.jsonl.
    const outSize = await sizeOf(`${dir}/${TURN_FILES.out}`);
    const acked = (await readAck(turn)) ?? 0;
    const there = await Promise.all(LOGS.map((f) => lstat(`${dir}/${f}`)));
    if (acked >= outSize && there.some(Boolean)) {
      if (!(await lstat(`${dir}/${ACK_FILE}`))) await writeAtomic(`${dir}/${ACK_FILE}`, `${outSize}\n`);
      for (const f of LOGS) await unlink(`${dir}/${f}`);
      done.logs.push(turn);
    }
    return st;
  }

  // ── Versions ──

  /** Whether a version’s daemon.pid names a live daemon. @param {string} code */
  async function daemonHolds(code) {
    const r = await readJson(`${code}/daemon.pid`);
    if (!r || !Number.isSafeInteger(r.pid) || typeof r.bootId !== 'string' || !Number.isSafeInteger(r.startTime)) return false;
    return Boolean(await sameProcess(r));
  }

  /** Whether a version’s start lock is held: its owner is live, or it has no owner record yet and is fresh. @param {string} lock */
  async function lockHeld(lock) {
    const st = await lstat(lock);
    if (!st) return false;
    const text = await fsp.readFile(`${lock}/${LOCK_OWNER}`, 'utf8').catch(() => null);
    if (text === null) return now() - st.mtimeMs < LOCK_FRESH_MS;
    return Boolean(await lockOwnerLive(parseLockOwner(text), { sameProcess }));
  }

  /**
   * Deletes older versions’ code folders that nothing uses, if this is the newest version installed.
   * @param {Map<string, number>} running  turns running, by the version that started them
   * @param {Swept} done
   */
  async function retire(running, done) {
    /** @type {string[]} */
    const versions = [];
    for (const name of await fsp.readdir(p.root).catch(() => [])) {
      if (!INSTALLED.test(name)) continue;
      if ((await lstat(`${p.root}/${name}`))?.isDirectory()) versions.push(name);
    }
    if (!INSTALLED.test(version) || versions.some((v) => compareVersions(v, version) > 0)) return;
    for (const v of versions.filter((x) => compareVersions(x, version) < 0)) {
      const code = `${p.root}/${v}`;
      const why = running.get(v)
        ? `${running.get(v)} of its turns still running`
        : (await daemonHolds(code))
          ? 'its daemon still running'
          : (await lockHeld(hostPaths(home, v).lock))
            ? 'an attach or install holding its start lock'
            : '';
      if (why) {
        done.skipped.push(v);
        continue;
      }
      await fsp.rm(code, { recursive: true, force: true });
      done.retired.push(v);
      log(`Retired version ${v}: deleted ${code}.`);
    }
  }

  // ── The root ──

  /** Why ~/.postbox-remote isn’t safe to clean, or '' if it is (or isn’t there). */
  async function rootProblem() {
    const st = await lstat(p.root);
    if (!st) return '';
    if (st.isSymbolicLink() || !st.isDirectory()) return `${p.root} isn’t a folder (it’s a link or a file), so Postbox won’t delete anything in it.`;
    let realHome;
    let realRoot;
    try {
      realHome = await fsp.realpath(home);
      realRoot = await fsp.realpath(p.root);
    } catch (e) {
      return `Couldn’t resolve ${p.root}: ${e.message}`;
    }
    if (realRoot !== `${realHome === '/' ? '' : realHome}/${REMOTE_DIR}`)
      return `${p.root} resolves to ${realRoot}, which isn’t ${REMOTE_DIR} in the home folder, so Postbox won’t delete it.`;
    const turns = await lstat(p.turns);
    if (turns && !turns.isDirectory()) return `${p.turns} isn’t a folder (it’s a link or a file), so Postbox won’t delete anything in it.`;
    return '';
  }

  return {
    readAck: (/** @type {string} */ turn) => serial(() => readAck(turn)),

    /**
     * Records Postbox’s ack for a turn, keeping the furthest, then cleans the turn (its logs may go now). Resolves
     * with the offset kept.
     * @param {string} turn @param {number} upTo
     */
    ack(turn, upTo) {
      return serial(async () => {
        const had = await readAck(turn);
        const keep = Math.max(had ?? 0, upTo);
        const dir = await turnDir(turn);
        if (dir && (had === null || keep > had)) await writeAtomic(`${dir}/${ACK_FILE}`, `${keep}\n`);
        await tidy(turn, emptySwept());
        return keep;
      });
    },

    /**
     * The size welcome.turns and `read` give for a turn whose out.jsonl was deleted: the acked size. Null while
     * out.jsonl is there.
     * @param {string} turn
     */
    async deletedSize(turn) {
      if (await lstat(p.turn(turn, TURN_FILES.out))) return null;
      if (!(await lstat(p.turn(turn, TURN_FILES.exit)))) return null;
      return readAck(turn);
    },

    /**
     * Writes start.agentFile to `<dir>/<name>`, 0600 (the folder made 0700 if it’s missing), recording it first so it
     * goes when the turn ends. A file already there is never written over or shared, whatever it holds: it may be the
     * person’s own, so the start fails.
     * @param {string} turn @param {{ dir: string, name: string, text: string }} file  dir: the daemon’s, from KIRO_HOME
     */
    writeAgentFile(turn, { dir, name, text }) {
      return serial(async () => {
        const path = `${dir}/${name}`;
        await writeAtomic(p.turn(turn, AGENT_RECORD), JSON.stringify({ path, sha256: sha256(text) }));
        try {
          await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
        } catch (e) {
          await unlink(p.turn(turn, AGENT_RECORD));
          throw new Error(`Couldn’t make the Kiro agents folder ${dir}: ${e.message}`);
        }
        try {
          await fsp.writeFile(path, text, { mode: FILE_MODE, flag: 'wx' });
        } catch (e) {
          await unlink(p.turn(turn, AGENT_RECORD));
          if (e.code === 'EEXIST') throw new Error(`There’s already a file at ${path}, so Postbox won’t replace it. Move it, or rename the persona.`);
          throw e;
        }
      });
    },

    /** Removes a turn’s agent file now: a start that failed after writing it. @param {string} turn */
    dropAgentFile(turn) {
      return serial(async () => {
        const dir = await turnDir(turn);
        if (dir) await dropAgentFile(turn, dir);
      });
    },

    /** One turn, as it ends. @param {string} turn */
    turnEnded(turn) {
      return serial(async () => {
        if (await rootProblem()) return;
        await tidy(turn, emptySwept());
      });
    },

    /** Every turn, then old versions. @returns {Promise<Swept>} */
    sweep() {
      return serial(async () => {
        const done = emptySwept();
        const bad = await rootProblem();
        if (bad) {
          log(bad);
          return done;
        }
        /** @type {Map<string, number>} */
        const running = new Map();
        for (const turn of await fsp.readdir(p.turns).catch(() => [])) {
          const st = await tidy(turn, done).catch((e) => {
            log(`Cleaning turn ${turn} failed: ${e.message}`);
            return null;
          });
          if (st?.state === 'running' && st.version) running.set(st.version, (running.get(st.version) ?? 0) + 1);
        }
        await retire(running, done).catch((e) => log(`Retiring old versions failed: ${e.message}`));
        return done;
      });
    },

    /**
     * For `remove`, once the turns are stopped: every agent file the turns wrote, other versions’ daemons (by
     * `signal`), then ~/.postbox-remote. Throws, deleting nothing, when the root isn’t safe to delete.
     * @param {(pid: number) => void} signal  ends another version’s daemon
     */
    removeAll(signal) {
      return serial(async () => {
        const bad = await rootProblem();
        if (bad) throw new Error(bad);
        for (const turn of await fsp.readdir(p.turns).catch(() => [])) {
          const dir = await turnDir(turn);
          if (dir) await dropAgentFile(turn, dir).catch((e) => log(`Couldn’t remove turn ${turn}’s agent file: ${e.message}`));
        }
        for (const name of await fsp.readdir(p.root).catch(() => [])) {
          if (!INSTALLED.test(name) || name === version) continue;
          const r = await readJson(`${p.root}/${name}/daemon.pid`);
          if (r && (await daemonHolds(`${p.root}/${name}`))) signal(r.pid);
        }
        await fsp.rm(p.root, { recursive: true, force: true });
        log(`Removed ${p.root}.`);
      });
    },

    rootProblem,
  };
}

/** @returns {Swept} */
const emptySwept = () => ({ folders: [], logs: [], capped: [], emptied: [], retired: [], skipped: [] });
