// Forms of private data the privacy checker (tools/privacy-check.mjs) learned after tests/fixtures-privacy.test.mjs
// reached its length: each spec is a hostile input and the exact finding it makes. As there, every example is built
// at run time, so this file’s own text holds none and the tree test checks it like any other.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkContentPrivacy, checkFilePrivacy } from '../tools/privacy-check.mjs';

/** JSON text for an object, so a key isn’t written in quotes here. @param {object} value */
const json = (value) => JSON.stringify(value);

/** That JSON escaped inside another JSON string, as a recorded line holds it. @param {object} value */
const escaped = (value) => JSON.stringify({ line: JSON.stringify(value) });

/** A committed file’s text, by its path from the repository’s root. @param {string} path */
const committed = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** An init’s mcp_servers, holding one claude.ai connector of this name. @param {string} name */
const connectors = (name) => ({ mcp_servers: [{ name: `claude.ai ${name}`, status: 'needs-auth', source: 'claudeai' }] });

test('privacy checker flags a claude.ai connector a person named, but not one from the directory (#661)', () => {
  assert.deepEqual(checkContentPrivacy(json(connectors('Alice Trip Planner'))), ['connector name at line 1']);
  assert.deepEqual(checkContentPrivacy(escaped(connectors('Alice Trip Planner'))), ['connector name at line 1']);
  for (const name of ['Claude Docs', 'Gmail', 'Google Calendar', 'Google Drive']) {
    assert.deepEqual(checkContentPrivacy(json(connectors(name))), [], name);
  }
  const hostInit = 'tests/fixtures/claude-code/host-mcp-init.jsonl';
  assert.deepEqual(checkFilePrivacy(hostInit, committed(hostInit)), [], 'the directory’s names in a recorded init pass');
});

/** The recorded Claude Code turns whose init once listed a person’s own connector and synced plugin paths (#661). */
const CLEARED_INITS = ['denials', 'fail-before-output', 'resume-after-failure', 'thinking-subagent'];

test('the recorded Claude Code inits list no MCP servers and no plugins (#661)', () => {
  for (const name of CLEARED_INITS) {
    const init = JSON.parse(committed(`tests/fixtures/claude-code/${name}.jsonl`).split('\n', 1)[0]);
    assert.equal(init.subtype, 'init', `${name} starts with its init`);
    assert.deepEqual({ mcp_servers: init.mcp_servers, plugins: init.plugins }, { mcp_servers: [], plugins: [] }, name);
  }
});

test('privacy checker flags a Bearer token, but not the word in prose or a placeholder (#696)', () => {
  const tail = 'Ab3'.repeat(10);
  assert.deepEqual(checkContentPrivacy(`Authorization: Bearer ${tail}`), ['token at line 1']);
  assert.deepEqual(checkContentPrivacy(json({ headers: { authorization: `bearer ${tail}` } })), ['token at line 1'], 'in any case');
  assert.equal(checkContentPrivacy(`Bearer ${'a'.repeat(20)}`).length, 1, 'a token at the shortest length');
  assert.equal(checkContentPrivacy(`Bearer ${'a'.repeat(19)}`).length, 0, 'one just short of it');
  assert.equal(checkContentPrivacy(`Bearer ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2ln'].join('.')}`).length, 1, 'a JWT');
  for (const text of ['send a Bearer token in the header', 'Authorization: Bearer <token>', 'curl -H "Authorization: Bearer $TOKEN"']) {
    assert.deepEqual(checkContentPrivacy(text), [], text);
  }
});

test('privacy checker flags a uid field that isn’t all zeros, quoted or not, but not a uuid (#696)', () => {
  assert.deepEqual(checkContentPrivacy(json({ uid: 501 })), ['uid at line 1']);
  assert.deepEqual(checkContentPrivacy(json({ uid: '1000' })), ['uid at line 1'], 'a uid written as a string');
  assert.deepEqual(checkContentPrivacy(escaped({ uid: 501 })), ['uid at line 1'], 'escaped inside a line');
  assert.deepEqual(checkContentPrivacy(json({ uid: 0 })), [], 'root, or a scrubbed uid');
  assert.deepEqual(checkContentPrivacy(json({ uid: -1 })), [], 'no user ids on this system');
  assert.deepEqual(checkContentPrivacy(json({ uuid: '501' })), [], 'another key that ends in uid');
});

/** Account keys, built here, as each written bare before a “:” or “=” is itself flagged. */
const PLAN_TYPE = ['plan', 'Type'].join('');
const AUTH_MODE = ['auth', 'mode'].join('_');

test('privacy checker flags an account field written bare, in YAML, JavaScript or TOML (#696)', () => {
  assert.deepEqual(checkContentPrivacy(`${PLAN_TYPE}: pro`), ['account field at line 1'], 'YAML');
  assert.deepEqual(checkContentPrivacy(`{${PLAN_TYPE}:"pro"}`), ['account field at line 1'], 'a JavaScript object');
  assert.deepEqual(checkContentPrivacy(`${['plan', 'type'].join('_')} = "pro"`), ['account field at line 1'], 'TOML');
  assert.deepEqual(checkContentPrivacy(`[account]\n${AUTH_MODE}="chatgpt"`), ['account field at line 2'], 'TOML with no spaces');
  assert.deepEqual(checkContentPrivacy(json({ [PLAN_TYPE]: 'pro' })), ['account field at line 1'], 'quoted, as before');
  for (const text of [`the ${PLAN_TYPE} field`, `if (event.${PLAN_TYPE} === 'pro')`, `keys: ['${PLAN_TYPE}', 'x']`, `my${PLAN_TYPE}: 1`]) {
    assert.deepEqual(checkContentPrivacy(text), [], text);
  }
});

test('a recording’s placeholder home is allowed only in its own joined deltas, and only that home (#784)', () => {
  const delta = (part) => JSON.stringify({ type: 'stream_event', event: { index: 1, delta: { type: 'text_delta', text: part } }, api_message_id: 'm' });
  const split = (path) => [path.slice(0, 4), path.slice(4)].map(delta).join('\n');
  const allowedIn = 'tests/fixtures/claude-code/permission-allow.jsonl';
  assert.deepEqual(checkFilePrivacy(allowedIn, split(['', 'Users', 'postbox', 'x'].join('/'))), [], 'its made-up project folder');
  assert.deepEqual(checkFilePrivacy(allowedIn, split(['', 'Users', 'alice', 'x'].join('/'))), ['home path in the deltas joined from line 1']);
  assert.deepEqual(checkFilePrivacy('tests/fixtures/x.jsonl', split(['', 'Users', 'postbox', 'x'].join('/'))), ['home path in the deltas joined from line 1']);
});

test('an installation id of zeros with white space in it is the scrubbed placeholder', () => {
  assert.deepEqual(checkContentPrivacy(json({ installationId: '0000 0000' })), []);
  assert.deepEqual(checkContentPrivacy(json({ installationId: '0000 0001' })), ['installationId at line 1']);
});
