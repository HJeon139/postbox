// #1530: Postbox’s close stops model lists from being kept, through start(), as a browser spec’s teardown meets it:
// a list a harness gives after Postbox closed, and its data folder was removed, writes nothing and logs nothing. The
// router is called with fake requests (start({ listen: false })), as tests/server-token.test.mjs does.

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { assertNoServerFailures, captureServerLog } from './server-log.mjs';
import { tempDir } from './temp-dirs.mjs';
import { untilTurns } from './until-turns.mjs';

// Its Postbox runs in this process: a test fails on an error or a warning it logs (tests/server-log.mjs).
captureServerLog();
afterEach(assertNoServerFailures);

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4463;

test('a model list a harness gives after Postbox closed and its folder went is neither kept nor logged', async () => {
  const dir = tempDir('pb-models-close-');
  const app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
  const call = (/** @type {any} */ r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });
  const cookie = String((await call({ path: '/', headers: NAVIGATION })).headers['set-cookie']).split(';')[0];
  /** @type {(models: string[]) => void} */
  let answer = () => {};
  let asked = 0;
  app.rt.adapters.get('mock').listModels = () => {
    asked++;
    return new Promise((r) => (answer = r));
  };
  const listing = call({ method: 'POST', path: '/api/backends/mock/models', body: {}, cookie });
  await untilTurns(() => asked > 0, 'the harness asked');
  assert.equal(asked, 1, 'the harness was asked');
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  answer(['m-late']);
  assert.equal((await listing).status, 200, 'the ask still gets its answer');
  assert.equal(existsSync(join(dir, 'model-lists.json')), false, 'nothing kept after the close');
});
