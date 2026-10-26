// Following a turn’s log (daemon.mjs’s header, #120): a log’s lines from an offset, then each line as the runner
// appends it while the turn runs, then (for out.jsonl) `ended`. A follower watches the turn folder and polls it too,
// since fs.watch can miss events.

import { promises as fsp, watch } from 'node:fs';
import { encodedBytes, REMOTE_LIMITS, TURN_FILES } from '../../../shared/remote-protocol.mjs';
import { READ_CHUNK } from './daemon-constants.mjs';
import { readExit, runnerAlive, sizeOf } from './daemon-files.mjs';
import { fail, send } from './daemon-reply.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').Conn} Conn */
/** @typedef {import('./daemon-constants.mjs').Follower} Follower */
/**
 * One follower’s state. The line being read: where it starts (lineStart), its bytes so far (parts, none kept once
 * it’s too long: skipping), and its length (held).
 * @typedef {{ d: Daemon, c: Conn, turn: string, which: 'out' | 'in', from: number, quiet: boolean, caughtUp: boolean,
 *   path: string, stopped: boolean, wake: () => void, poked: boolean, watcher: import('node:fs').FSWatcher | null,
 *   timer: NodeJS.Timeout | null, pos: number, lineStart: number, parts: Buffer[], held: number, skipping: boolean,
 *   decoder: TextDecoder }} Follow
 */

/**
 * Sends a log’s lines from an offset, then follows it while the turn runs, then (for out.jsonl) `ended`. A quiet
 * follower sends only `ended`: the answer to a stop from a connection that isn’t reading the turn. A follower for a
 * `read` (`caughtUp`) says `caught-up` once, when its first pass has sent every line the log had then.
 * @param {Daemon} d @param {Conn} c @param {string} turn @param {'out' | 'in'} which @param {number} from @param {boolean} quiet
 * @param {boolean} [caughtUp]
 */
export function follow(d, c, turn, which, from, quiet, caughtUp = false) {
  const key = `${turn}:${which}`;
  c.follows.get(key)?.stop();
  const dir = d.p.turn(turn);
  const path = `${dir}/${which === 'in' ? TURN_FILES.in : TURN_FILES.out}`;
  /** @type {Follow} */
  const fl = {
    d,
    c,
    turn,
    which,
    from,
    quiet,
    caughtUp,
    path,
    stopped: false,
    wake: () => {},
    poked: false,
    watcher: null,
    timer: null,
    pos: from,
    lineStart: from,
    parts: [],
    held: 0,
    skipping: false,
    decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }),
  };
  /** @type {Follower} */
  const f = {
    stop() {
      fl.stopped = true;
      f.poke();
    },
    poke() {
      fl.poked = true;
      fl.wake();
    },
  };
  c.follows.set(key, f);
  watchDir(fl, dir, f);
  run(fl)
    .catch((e) => {
      d.log(`Following turn ${turn}’s ${which} log failed: ${e.stack ?? e.message}`);
      fail(c, 'internal', `Couldn’t read turn ${turn}’s ${which} log: ${e.message}`, 'read', turn);
    })
    .finally(() => {
      fl.watcher?.close();
      if (fl.timer) clearTimeout(fl.timer);
      if (c.follows.get(key) === f) c.follows.delete(key);
    });
  return f;
}

/** Pokes the follower at each change in the turn folder. @param {Follow} fl @param {string} dir @param {Follower} f */
function watchDir(fl, dir, f) {
  try {
    fl.watcher = watch(dir, () => f.poke());
    fl.watcher.on('error', () => {
      fl.watcher?.close();
      fl.watcher = null;
    });
    fl.watcher.unref();
  } catch (e) {
    // Polling alone still sees everything, POLL_MS late (inotify’s watch limit, say).
    fl.d.log(`Couldn’t watch ${dir} (${e.message}); polling it every ${fl.d.pollMs} ms.`);
  }
}

/** Waits for a poke or pollMs, whichever comes first. @param {Follow} fl */
const nap = (fl) =>
  new Promise((resolve) => {
    if (fl.poked || fl.stopped) {
      fl.poked = false;
      return resolve(undefined);
    }
    fl.wake = () => {
      fl.wake = () => {};
      if (fl.timer) clearTimeout(fl.timer);
      fl.poked = false;
      resolve(undefined);
    };
    fl.timer = setTimeout(() => fl.wake(), fl.d.pollMs);
    fl.timer.unref();
  });

/** Sends one line, or a cut one: too long, not UTF-8, or too big as a message. @param {Follow} fl @param {number} offset @param {number} next @param {boolean} cut */
async function emit(fl, offset, next, cut) {
  const base = { turn: fl.turn, ...(fl.which === 'in' ? { log: fl.which } : {}), offset, next };
  /** @type {string | null} */
  let text = null;
  if (!cut) {
    try {
      text = fl.decoder.decode(fl.parts.length === 1 ? fl.parts[0] : Buffer.concat(fl.parts, fl.held));
    } catch {
      text = null;
    }
  }
  const body = text === null ? null : { ...base, text };
  if (body && encodedBytes({ type: 'line', ...body }) <= REMOTE_LIMITS.lineBytes) await send(fl.c, 'line', body);
  else await send(fl.c, 'line', { ...base, text: '', cut: true });
}
/** @param {Follow} fl @param {number} next */
function reset(fl, next) {
  fl.parts = [];
  fl.held = 0;
  fl.skipping = false;
  fl.lineStart = next;
}
/** @param {Follow} fl @param {Buffer} buf */
async function take(fl, buf) {
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    const end = nl === -1 ? buf.length : nl;
    const n = end - i;
    if (!fl.skipping && fl.held + n > REMOTE_LIMITS.streamLineBytes) {
      fl.skipping = true;
      fl.parts = [];
    }
    if (!fl.skipping && n) fl.parts.push(Buffer.from(buf.subarray(i, end)));
    fl.held += n;
    if (nl === -1) break;
    const next = fl.lineStart + fl.held + 1;
    await emit(fl, fl.lineStart, next, fl.skipping);
    reset(fl, next);
    i = nl + 1;
  }
}
/** Reads to the end of the file as it is now. @param {Follow} fl */
async function drain(fl) {
  let fh;
  try {
    fh = await fsp.open(fl.path, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    for (;;) {
      if (fl.stopped) return;
      const { bytesRead } = await fh.read(buf, 0, buf.length, fl.pos);
      if (!bytesRead) return;
      fl.pos += bytesRead;
      await take(fl, buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
}

/** @param {Follow} fl */
async function run(fl) {
  const { d, c, turn, which, quiet } = fl;
  let misses = 0;
  while (!fl.stopped && !c.closed) {
    let exit = await readExit(d, turn);
    let over = Boolean(exit);
    if (!over) {
      // Interrupted: the runner doesn’t answer twice running, or isn’t the one runner.json names.
      if (d.dead.has(turn) || !(await runnerAlive(d, turn))) misses++;
      else misses = 0;
      if (d.dead.has(turn) || misses >= 2) {
        exit = await readExit(d, turn);
        over = true;
      }
    }
    if (!quiet) await drain(fl);
    if (fl.stopped || c.closed) return;
    // The last line may have no \n; it’s sent now that nothing more will come.
    if (over && !quiet && (fl.held || fl.skipping)) {
      await emit(fl, fl.lineStart, fl.lineStart + fl.held, fl.skipping);
      reset(fl, fl.lineStart + fl.held);
    }
    if (fl.caughtUp) {
      // Every line the log had when this pass got to its end has gone: size is the file’s size then, less a last
      // line still without its \n, which waits for more.
      fl.caughtUp = false;
      await send(c, 'caught-up', { turn, log: which, size: quiet ? fl.from : fl.lineStart });
    }
    if (over) {
      if (which === 'out') await send(c, 'ended', { turn, exit, size: (await d.cleanup.deletedSize(turn)) ?? (await sizeOf(fl.path)) });
      if (exit) d.cleanup.turnEnded(turn).catch((e) => d.log(`Cleaning turn ${turn} failed: ${e.message}`));
      return;
    }
    await nap(fl);
  }
}
