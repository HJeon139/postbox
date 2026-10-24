// The run’s own Postbox (tools/uat-run.mjs): a fresh server on the run’s port and data folder, recording every agent
// turn’s stream, with its output in the run’s log. Stopping the run stops it too.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sleep } from '../cdp.mjs';

/**
 * Starts Postbox and waits until it answers. `api` reads one of its routes, and refuses once it has exited.
 * @param {{ root: string, port: number, data: string, env: Record<string, string>, log: (line: string) => void }} o
 */
export async function startPostbox({ root, port, data, env, log }) {
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs'), '--port', String(port), '--data', data, '--fresh'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => log(`postbox: ${String(d).trim()}`));
  server.stderr.on('data', (d) => log(`postbox (stderr): ${String(d).trim()}`));
  let exited = null;
  server.on('exit', (code) => (exited = code));
  // Stopping the run stops its Postbox too, and with it the agents' turns: an orphaned server keeps agents running,
  // and spending, after the run is gone.
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      if (exited === null) server.kill('SIGTERM');
      process.exit(130);
    });
  const api = async (p) => {
    if (exited !== null) throw new Error(`Postbox exited (code ${exited}); see run.log.`);
    return (await fetch(origin + p)).json();
  };
  for (let i = 0; ; i++) {
    try {
      await api('/api/state');
      break;
    } catch (e) {
      if (exited !== null || i > 80) throw new Error(`Postbox didn’t start: ${e.message}`);
      await sleep(250);
    }
  }
  return { origin, api, kill: () => server.kill() };
}
