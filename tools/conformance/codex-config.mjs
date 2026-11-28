// The Codex config a conformance probe writes in its temp CODEX_HOME (#585): a model provider that is a fake Responses
// endpoint on this computer’s loopback, so a turn runs with no real model, no sign-in and no token.

import { PLACEHOLDER_VAR } from './sandbox-env.mjs';

/** The provider’s id in config.toml, and the model name the fake answers for. */
export const FAKE_PROVIDER = 'postbox_conformance';
export const FAKE_MODEL = 'postbox-conformance-model';

/**
 * The URL a fake provider may have: plain HTTP on 127.0.0.1 with a port, and nothing else, so a probe’s request
 * can never leave this computer. Returns the URL without a trailing slash, or throws.
 * @param {string} baseUrl
 */
export function loopbackUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`The fake provider’s address isn’t a URL: ${baseUrl}`);
  }
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '';
  if (!loopback || url.username || url.password) throw new Error(`The fake provider must be http://127.0.0.1:<port>, not ${url.origin}.`);
  return url.href.replace(/\/$/, '');
}

/**
 * What every probe’s config.toml sets, whatever Codex’s defaults become in a later version: sign-in kept in a file
 * under the temp CODEX_HOME rather than the system keyring, no update check, and no analytics. The key names are
 * codex-cli 0.167.0’s (its binary names all three, and documents `[analytics] enabled = false`). OTEL is left at
 * Codex’s default: the binary doesn’t show its off setting plainly enough to write it.
 */
const BASE_KEYS = ['cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false'];
const BASE_TABLES = ['[analytics]', 'enabled = false'];

/** config.toml for a probe with no model turn: the base settings alone. */
export const baseConfigToml = () => [...BASE_KEYS, '', ...BASE_TABLES, ''].join('\n');

/**
 * config.toml for the probe’s CODEX_HOME: the base settings, and the fake provider as the default, speaking the
 * Responses API, with the placeholder’s variable as its key and no OpenAI sign-in. Checked with codex-cli 0.167.0.
 * @param {string} baseUrl  the fake’s address, such as http://127.0.0.1:4321/v1
 */
export function codexConfigToml(baseUrl) {
  const url = loopbackUrl(baseUrl);
  return [
    `model = ${JSON.stringify(FAKE_MODEL)}`,
    `model_provider = ${JSON.stringify(FAKE_PROVIDER)}`,
    ...BASE_KEYS,
    '',
    `[model_providers.${FAKE_PROVIDER}]`,
    'name = "Postbox conformance fake"',
    `base_url = ${JSON.stringify(url)}`,
    'wire_api = "responses"',
    `env_key = ${JSON.stringify(PLACEHOLDER_VAR)}`,
    'requires_openai_auth = false',
    '',
    ...BASE_TABLES,
    '',
  ].join('\n');
}
