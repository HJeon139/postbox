// The postbox command’s --hosted flag (bin/postbox.mjs): the settings file’s public origin and sign-in reach start(),
// with every address to listen on, and a file that can’t be read stops the command before anything starts.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { main } from '../bin/postbox.mjs';
import { fetchKeyText } from '../server/identity/alb-key-fetch.mjs';
import { SETTINGS } from './alb-fixture.mjs';
import { tempDir } from './temp-dirs.mjs';

/** Runs the command with a start() that records what it was given and starts nothing. */
async function run(/** @type {string[]} */ argv) {
  /** @type {any[]} */
  const started = [];
  const said = mock.method(console, 'error', () => {});
  const exit = mock.method(process, 'exit', (/** @type {number} */ code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    const outcome = await main(argv, /** @type {any} */ (async (/** @type {any} */ opts) => started.push(opts) && { close: async () => {} })).then(
      () => 'started',
      (e) => e.message,
    );
    return { outcome, started, said: said.mock.calls.map((c) => String(c.arguments[0])) };
  } finally {
    exit.mock.restore();
    said.mock.restore();
    for (const event of ['unhandledRejection', 'SIGINT', 'SIGTERM']) process.removeAllListeners(event);
  }
}

test('--hosted gives start() the file’s public origin and sign-in, and every address to listen on', async () => {
  const dir = tempDir('pb-cmd-hosted-');
  const file = join(dir, 'hosted.json');
  writeFileSync(file, JSON.stringify({ origin: 'https://postbox.example.com', signIn: SETTINGS }));
  const { outcome, started } = await run(['--port', '4597', '--data', join(dir, 'data'), '--hosted', file]);
  assert.equal(outcome, 'started');
  const { host, publicOrigin, signIn, port } = started[0];
  assert.deepEqual(
    { host, publicOrigin, signIn, port },
    { host: '0.0.0.0', publicOrigin: 'https://postbox.example.com', signIn: { settings: SETTINGS, get: fetchKeyText }, port: 4597 },
  );
});

test('without --hosted, start() is given no public origin, no sign-in and no address: it listens on this computer alone', async () => {
  const dir = tempDir('pb-cmd-local-');
  const { started } = await run(['--port', '4596', '--data', join(dir, 'data')]);
  assert.deepEqual([started[0].host, started[0].publicOrigin, started[0].signIn], [undefined, undefined, undefined]);
});

test('a --hosted file that can’t be read stops the command with what was wrong, and starts nothing', async () => {
  const dir = tempDir('pb-cmd-hosted-bad-');
  const { outcome, started, said } = await run(['--port', '4595', '--data', join(dir, 'data'), '--hosted', join(dir, 'missing.json')]);
  assert.deepEqual([outcome, started.length], ['exit 2', 0]);
  assert.match(said[0], /couldn’t read the hosted settings at .*missing\.json/);
});
