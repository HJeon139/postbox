// #1044: the page’s default chain limit is the server’s, so it follows POSTBOX_CHAIN_LIMIT, which shared/limits.mjs
// reads as it loads (server/page-state.mjs, defaultChainLimit). Each case starts a Postbox module with that environment.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PAGE_STATE = fileURLToPath(new URL('../../server/page-state.mjs', import.meta.url));

/** The page’s defaultChainLimit, from a Postbox started with this environment. @param {Record<string, string>} env */
function pageDefault(env) {
  const script = `
    const { pageState } = await import(process.argv[1]);
    const store = { epoch: 'ep', status: {}, state: { seq: 0 } };
    const rt = { localBackends: () => [], config: {}, store, running: { all: () => [] } };
    const adapters = { names: () => [], get: () => ({}), runsHere: () => true };
    const page = pageState({ store, rt, adapters, origin: '', demo: false, real: null, config: {}, headers: { all: () => ({}) } });
    process.stdout.write(String(page.config.defaultChainLimit));
  `;
  const { POSTBOX_CHAIN_LIMIT: _drop, ...rest } = process.env;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, PAGE_STATE], { env: { ...rest, ...env }, encoding: 'utf8' });
}

test('#1044: the page’s default chain limit is the server’s, POSTBOX_CHAIN_LIMIT when set', () => {
  assert.equal(pageDefault({}), '1000');
  assert.equal(pageDefault({ POSTBOX_CHAIN_LIMIT: '37' }), '37');
});
