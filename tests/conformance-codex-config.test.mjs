// #585: the backend conformance probe runs Codex against a fake model endpoint. Its config must point only at this
// computer’s loopback, and its environment must carry no key or token from the real one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseConfigToml, codexConfigToml, loopbackUrl } from '../tools/conformance/codex-config.mjs';
import { PLACEHOLDER, PLACEHOLDER_VAR, refuseSecretNames, sandboxEnv } from '../tools/conformance/sandbox-env.mjs';

test('the fake provider’s address may be http on 127.0.0.1 with a port', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:4321/v1'), 'http://127.0.0.1:4321/v1');
  assert.equal(loopbackUrl('http://127.0.0.1:4321/v1/'), 'http://127.0.0.1:4321/v1');
});

test('the config builder refuses any address that isn’t 127.0.0.1', () => {
  for (const url of [
    'http://localhost:4321/v1',
    'http://0.0.0.0:4321/v1',
    'http://127.0.0.2:4321/v1',
    'http://[::1]:4321/v1',
    'http://api.openai.com:80/v1',
    'http://127.0.0.1.example.com:4321/v1',
    'https://127.0.0.1:4321/v1',
    'http://127.0.0.1/v1',
    'http://user:pw@127.0.0.1:4321/v1',
    'not a url',
  ])
    assert.throws(() => codexConfigToml(url), /fake provider/, url);
});

test('the config names the fake as Codex’s provider, with the placeholder’s variable and no OpenAI sign-in', () => {
  const toml = codexConfigToml('http://127.0.0.1:4321/v1');
  assert.match(toml, /^model_provider = "postbox_conformance"$/m);
  assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:4321\/v1"$/m);
  assert.match(toml, /^wire_api = "responses"$/m);
  assert.match(toml, new RegExp(`^env_key = "${PLACEHOLDER_VAR}"$`, 'm'));
  assert.match(toml, /^requires_openai_auth = false$/m);
});

test('the probe’s environment passes PATH and its own folders, and nothing that names a key or a token', () => {
  const from = { PATH: '/bin', HOME: '/home/someone', OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'x', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', LANG: 'C' };
  const env = sandboxEnv({ from, home: '/probe', codexHome: '/probe/codex', placeholder: true });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/probe', CODEX_HOME: '/probe/codex', [PLACEHOLDER_VAR]: PLACEHOLDER });
});

test('the probe’s environment has no placeholder unless asked, and never the real HOME', () => {
  assert.deepEqual(sandboxEnv({ from: { PATH: '/bin', HOME: '/home/someone' }, home: '/probe' }), { PATH: '/bin', HOME: '/probe' });
  assert.throws(() => sandboxEnv({ from: { PATH: '/bin', HOME: '/home/someone' }, home: '' }), /temp HOME/);
});

test('an environment that names a secret is refused, the placeholder’s own variable aside', () => {
  assert.throws(() => refuseSecretNames({ PATH: '/bin', OPENAI_API_KEY: 'sk-x' }), /OPENAI_API_KEY/);
  assert.throws(() => refuseSecretNames({ GITHUB_TOKEN: 'x' }), /GITHUB_TOKEN/);
  assert.throws(() => refuseSecretNames({ [PLACEHOLDER_VAR]: 'a real key' }), new RegExp(PLACEHOLDER_VAR));
  assert.doesNotThrow(() => refuseSecretNames({ PATH: '/bin', HOME: '/probe', [PLACEHOLDER_VAR]: PLACEHOLDER }));
});

test('every probe’s config keeps sign-in in a file, checks for no update and sends no analytics', () => {
  for (const toml of [baseConfigToml(), codexConfigToml('http://127.0.0.1:4321/v1')]) {
    assert.match(toml, /^cli_auth_credentials_store = "file"$/m);
    assert.match(toml, /^check_for_update_on_startup = false$/m);
    assert.match(toml, /^\[analytics\]\nenabled = false$/m);
  }
});

test('the provider config’s top-level keys all come before its first table, as TOML reads them', () => {
  const toml = codexConfigToml('http://127.0.0.1:4321/v1');
  const firstTable = toml.indexOf('\n[');
  for (const key of ['model =', 'model_provider =', 'cli_auth_credentials_store =', 'check_for_update_on_startup ='])
    assert.ok(toml.indexOf(key) < firstTable, key);
});
