// The run’s own Postbox (tools/uat-run.mjs): a fresh server on the run’s port and data folder, recording every agent
// turn’s stream, with its output in the run’s log. It runs in a process group of its own, so a terminal’s Ctrl-C
// reaches the runner, not it: the runner cleans its hosts up through it first, then stops it (tools/uat/stop.mjs).
// The runner’s exit stops it in any case. A host-mode run’s restart fault (#120) stops it and starts it again on
// the same data, as Ctrl-C and a start without --fresh would.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { sleep } from '../browser.mjs';
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
 *   server: import('node:child_process').ChildProcess | null, exited: number|null, origin: string }} Run
 */

/** Starts the server, fresh or on the data it left. @param {Run} pb @param {boolean} fresh */
function spawnServer(pb, fresh) {
  const server = spawn(process.execPath, [join(pb.root, 'server', 'index.mjs'), '--port', String(pb.port), '--data', pb.data, ...(fresh ? ['--fresh'] : [])], {
    cwd: pb.root,
    env: { ...process.env, ...pb.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.on('data', (d) => pb.log(`postbox: ${String(d).trim()}`));
  server.stderr?.on('data', (d) => pb.log(`postbox (stderr): ${String(d).trim()}`));
  pb.exited = null;
  server.on('exit', (code) => {
    if (pb.server === server) pb.exited = code;
  });
  pb.server = server;
}

/** Waits until it answers. @param {Run} pb @param {(p: string) => Promise<any>} api */
async function ready(pb, api) {
  for (let i = 0; ; i++) {
    try {
      await api('/api/state');
      return;
    } catch (e) {
      if (pb.exited !== null || i > 80) throw new Error(`Postbox didn’t start: ${e.message}`);
      await sleep(250);
    }
  }
}

/**
 * Starts Postbox and waits until it answers. `api` reads one of its routes, and refuses once it has exited.
 * @param {{ root: string, port: number, data: string, env: Record<string, string>, log: (line: string) => void }} o
 */
export async function startPostbox({ root, port, data, env, log }) {
  /** @type {Run} */
  const pb = { root, port, data, env, log, server: null, exited: null, origin: `http://127.0.0.1:${port}` };
  spawnServer(pb, true);
  // The run’s end stops its Postbox too, and with it the agents’ turns here: an orphaned server keeps agents running,
  // and spending, after the run is gone.
  process.once('exit', () => {
    if (pb.exited === null) pb.server?.kill('SIGTERM');
  });
  const api = async (p) => {
    if (pb.exited !== null) throw new Error(`Postbox exited (code ${pb.exited}); see run.log.`);
    return (await fetch(pb.origin + p)).json();
  };
  await ready(pb, api);
  return {
    origin: pb.origin,
    api,
    /** Stops it, and resolves once it has exited, so its port is free. */
    kill: async () => {
      if (pb.server) await untilGone(pb.server);
    },
    /** Its process, whose children are its ssh to each host. */
    get pid() {
      return pb.server?.pid;
    },
    /** Stops it as Ctrl-C does, and starts it again on the same data. Resolves with how long it was down, in ms. */
    async restart() {
      const old = pb.server;
      const down = Date.now();
      const gone = new Promise((ok) => old?.once('exit', ok));
      old?.kill('SIGINT');
      if (!(await Promise.race([gone.then(() => true), sleep(20_000).then(() => false)]))) old?.kill('SIGKILL');
      spawnServer(pb, false);
      await ready(pb, api);
      return Date.now() - down;
    },
  };
}
