#!/usr/bin/env node
// The postbox command (#157): starts Postbox on this computer, with the person’s data in ~/.postbox (#90). npm links it
// when Postbox is installed, `npm start` runs it in a clone, and `node server/index.mjs` hands its flags to it.

import { realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildInfo } from '../server/build-info.mjs';
import { dataFolder, lockData, moveData, postboxHome } from '../server/home.mjs';
import { checkPlatform } from '../server/redis-platform.mjs';
import { stopRedis } from '../server/store-redis.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const HELP = `Usage: postbox [options]

Starts Postbox at http://127.0.0.1:<port>/. It listens on this computer only.

Options:
  --port <n>       The port to listen on (4173).
  --data <folder>  The data folder: conversations, attachments and agents’ workspaces.
                   Without it, Postbox uses $POSTBOX_HOME, else ~/.postbox.
  --fresh          Start from an empty store (keeps attachments and workspaces).
  --demo           Seed the demo’s agents and conversations, with scripted agents only.
  --move-data      Move a clone’s data/ folder to ~/.postbox, then exit.
  -v, --version    Print the version.
  -h, --help       Print this help.`;

/**
 * Reads the flags and runs: prints help or the version, moves a clone’s data when asked, or starts Postbox and stops
 * it on Ctrl-C.
 * @param {string[]} argv  the flags, without node and the script
 * @param {typeof import('../server/index.mjs').start} start  passed in: server/index.mjs runs this while it’s still loading
 * @param {{ platform: string, arch: string }} [host]  where it runs; tests pass another
 */
export async function main(argv, start, host = { platform: process.platform, arch: process.arch }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        data: { type: 'string' },
        fresh: { type: 'boolean' },
        demo: { type: 'boolean' },
        'move-data': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(buildInfo({ root: ROOT }).version);
  if (values['move-data']) {
    try {
      const { from, to, leftover } = await moveData({ root: ROOT });
      console.log(
        `Moved ${from} to ${to}, and left a link in its place. Postbox uses ${to} from now on.\nAn agent that works in its own workspace folder, rather than a project’s, starts a new Claude Code session on its next turn, since its folder moved; its conversation in Postbox stays as it was.`,
      );
      if (leftover) console.log(`Couldn’t remove the original, now at ${leftover}. Remove it yourself once you’ve checked ${to}.`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }
  const port = values.port === undefined ? 4173 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port takes a port number from 1 to 65535, not “${values.port}”.`);
    process.exit(2);
  }
  // Postbox’s store is a Redis 8 build it has only for some platforms: refuse the others before anything is written
  // or downloaded (designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”).
  const where = checkPlatform(host);
  if (!where.ok) {
    console.error(where.message);
    process.exit(1);
  }
  const { dataDir, from } = dataFolder({ data: values.data, root: ROOT });
  let release;
  try {
    release = lockData(dataDir);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  process.on('exit', release);
  // A promise nothing awaited that rejects, such as an async timer callback’s, is logged with its stack, and Postbox
  // keeps running (#510). Node’s default exits, which stopped every conversation for one failed callback, as a persona
  // delete’s purge did in PR #496. An uncaught exception still exits, as Node advises, with its stack on stderr.
  process.on('unhandledRejection', (e) =>
    console.error(`Postbox kept running after an error nothing handled. Please report it, with this:\n${e instanceof Error ? e.stack : String(e)}`),
  );
  const stop = stopOnSignal();
  let app;
  try {
    app = await start({ port, dataDir, fresh: values.fresh, demo: values.demo });
  } catch (e) {
    // A start that a signal stopped fails as it stops: the signal’s stop exits. Any other failure stops the store’s
    // Redis child before the error ends Postbox.
    if (stop.stopping) await stop.stopping;
    await stopRedis();
    throw e;
  }
  // A signal during the start: its stop exits.
  if (stop.stopping) return await stop.stopping;
  stop.started(app);
  if (from === 'clone')
    console.log(
      `This clone’s data/ folder has your conversations, so Postbox keeps using it. Postbox now keeps its data in ${postboxHome()}: to move it there, stop Postbox and run \`npm start -- --move-data\`.`,
    );
}

/**
 * Stops Postbox on Ctrl-C or SIGTERM, from before its start begins (SR-6, a clean shutdown). Once Postbox runs, it
 * closes and exits 0. During the start, the store’s Redis child is stopped, or never spawned, and the data folder’s
 * claims go, before Postbox exits as the signal would have ended it (128 + its number). A second signal exits at once;
 * a Redis child still running then gets SIGTERM as Postbox exits (server/redis-supervisor.mjs).
 * @returns {{ stopping: Promise<never> | null, started: (app: { close: () => Promise<void> }) => void }}
 */
function stopOnSignal() {
  /** @type {{ close: () => Promise<void> } | null} */
  let app = null;
  const state = {
    /** @type {Promise<never> | null} the stop a signal began, which exits */
    stopping: null,
    /** @param {{ close: () => Promise<void> }} a */
    started: (a) => {
      app = a;
    },
  };
  /** @param {NodeJS.Signals} signal */
  const on = (signal) => {
    const code = 128 + osConstants.signals[signal];
    if (state.stopping) process.exit(app ? 0 : code);
    state.stopping = (app ? app.close().then(() => 0) : stopRedis().then(() => code)).then((c) => process.exit(c));
  };
  process.on('SIGINT', on);
  process.on('SIGTERM', on);
  return state;
}

// Run as the command. npm links it from its bin folder, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { start } = await import('../server/index.mjs');
  await main(process.argv.slice(2), start);
}
