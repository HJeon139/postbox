// The run’s own Postbox (tools/uat-run.mjs): a fresh server on the run’s port and data folder, recording every agent
// turn’s stream, with its output in the run’s log and, line by line, in its output record (tools/uat/postbox-output.mjs),
// which also notes an exit nothing asked for. It runs in a process group of its own, so a terminal’s Ctrl-C
// reaches the runner, not it: the runner cleans its hosts up through it first, then stops it (tools/uat/stop.mjs).
// The runner’s exit stops it in any case. A host-mode run’s restart fault (#120) stops it and starts it again on
// the same data, as Ctrl-C and a start without --fresh would.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { outputRecorder } from './postbox-output.mjs';
import { withItems } from './state-items.mjs';
import { untilGone } from './until-gone.mjs';

/** Whether nothing listens on this port here. @param {number} port */
export const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)))
      .listen(port, '127.0.0.1');
  });

/**
 * @typedef {{ root: string, port: number, data: string, env: Record<string, string>, log: (line: string) => void,
 *   server: import('node:child_process').ChildProcess | null, exited: number|null, origin: string,
 *   output: ReturnType<typeof outputRecorder>, stopping: boolean }} Run
 */

/** Starts the server, fresh or on the data it left. @param {Run} pb @param {boolean} fresh */
function spawnServer(pb, fresh) {
  const server = spawn(process.execPath, [join(pb.root, 'server', 'index.mjs'), '--port', String(pb.port), '--data', pb.data, ...(fresh ? ['--fresh'] : [])], {
    cwd: pb.root,
    env: { ...process.env, ...pb.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.on('data', (d) => {
    pb.log(`postbox: ${String(d).trim()}`);
    pb.output.feed('stdout', String(d));
  });
  server.stderr?.on('data', (d) => {
    pb.log(`postbox (stderr): ${String(d).trim()}`);
    pb.output.feed('stderr', String(d));
  });
  pb.exited = null;
  pb.stopping = false;
  server.on('exit', (code) => {
    if (pb.server === server) pb.exited = code;
  });
  // Once its output has ended: an exit the run didn’t ask for, by kill() or restart(), is a crash.
  server.on('close', (code, signal) => {
    pb.output.flush();
    if (pb.server === server && !pb.stopping) pb.output.exited(code, signal);
  });
  pb.server = server;
}

/** Waits until it answers, trying up to tries times. @param {Run} pb @param {(p: string) => Promise<any>} api @param {number} [tries] */
async function ready(pb, api, tries = 80) {
  for (let i = 0; ; i++) {
    try {
      await api('/api/state');
      return;
    } catch (e) {
      if (pb.exited !== null || i > tries) throw new Error(`Postbox didn’t start: ${e.message}`);
      await sleep(250);
    }
  }
}

/**
 * Starts Postbox and waits until it answers. `api` reads one of its routes, and refuses once it has exited. One that
 * doesn’t answer within `tries` is stopped before the error reaches the caller, which may go on (#782). step says which
 * step of the run is going on, for each line of its output.
 * @param {{ root: string, port: number, data: string, env: Record<string, string>, log: (line: string) => void,
 *   tries?: number, step?: () => number | null }} o
 */
export async function startPostbox({ root, port, data, env, log, tries = 80, step = () => null }) {
  /** @type {Run} */
  const pb = { root, port, data, env, log, server: null, exited: null, origin: `http://127.0.0.1:${port}`, output: outputRecorder(step), stopping: false };
  spawnServer(pb, true);
  // The run’s end stops its Postbox too, and with it the agents’ turns here: an orphaned server keeps agents running,
  // and spending, after the run is gone.
  process.once('exit', () => {
    if (pb.exited === null) pb.server?.kill('SIGTERM');
  });
  const get = async (p) => {
    if (pb.exited !== null) throw new Error(`Postbox exited (code ${pb.exited}); see run.log.`);
    return (await fetch(pb.origin + p)).json();
  };
  // The state with its items, which /api/state no longer carries (#1155): the checks and triggers read them there.
  const api = async (p) => {
    const body = await get(p);
    return p === '/api/state' && body?.state ? { ...body, state: await withItems(body.state, get) } : body;
  };
  const stop = async () => {
    pb.stopping = true;
    if (pb.server) await untilGone(pb.server);
  };
  try {
    await ready(pb, api, tries);
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    origin: pb.origin,
    api,
    /** What it has printed so far, line by line, and when it exited by itself (tools/uat/postbox-output.mjs). */
    output: pb.output.output,
    /** Stops it, and resolves once it has exited, so its port is free. */
    kill: stop,
    /** Its process, whose children are its ssh to each host. */
    get pid() {
      return pb.server?.pid;
    },
    /**
     * Stops it as Ctrl-C does, and starts it again on the same data. Resolves with how long it was down, in ms.
     * whileDown runs between the two, as a seed that writes into its store does (tools/uat/big-room.mjs).
     * @param {{ whileDown?: () => Promise<void> }} [o]
     */
    async restart({ whileDown } = {}) {
      const old = pb.server;
      const down = Date.now();
      const gone = new Promise((ok) => old?.once('exit', ok));
      pb.stopping = true;
      old?.kill('SIGINT');
      if (!(await Promise.race([gone.then(() => true), sleep(20_000).then(() => false)]))) {
        old?.kill('SIGKILL');
        await gone;
      }
      if (whileDown) await whileDown();
      spawnServer(pb, false);
      await ready(pb, api);
      return Date.now() - down;
    },
  };
}
