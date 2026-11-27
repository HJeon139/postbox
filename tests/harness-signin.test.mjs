// How each harness’s status command reads (server/remote/host/harness-signin.mjs, #1608), from the runs recorded in
// tests/fixtures/remote/signin/ (its README says how): signed in, signed out, and anything else unknown, with nothing
// of the account’s email, organization or folders kept.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readClaude, readCodex, readKiro, STATUS_COMMANDS } from '../server/remote/host/harness-signin.mjs';

/** A recorded run: how it exited, and its stdout. @param {string} name */
const run = (name) => {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/remote/signin/${name}.json`, import.meta.url), 'utf8'));
  return { exit: f.exit, stdout: f.stdout, command: f.command };
};

test('each harness’s status command is the one recorded, without its program', () => {
  for (const [harness, fixture] of [
    ['claude-code', 'claude-signed-in'],
    ['codex', 'codex-signed-in'],
    ['kiro-cli', 'kiro-signed-in'],
  ])
    assert.deepEqual(STATUS_COMMANDS[harness].args, run(fixture).command.slice(1), harness);
  assert.equal(STATUS_COMMANDS.codex.reads, false, 'Codex’s output isn’t read at all');
});

test('Claude Code signed in keeps its method and when it runs out, and nothing else of the output', () => {
  const r = readClaude(run('claude-signed-in'));
  assert.deepEqual(r, { state: 'signed-in', method: 'claude.ai', expiresAt: Date.parse('2026-12-01T00:00:00.000Z') });
});

test('Claude Code with an empty config folder is signed out', () => {
  assert.deepEqual(readClaude(run('claude-signed-out')), { state: 'signed-out' });
});

test('a Claude Code too old for auth status is unknown, never signed out', () => {
  // Its exit 1 says only that it didn’t understand: with no JSON that says loggedIn false, it isn’t a sign-out.
  assert.deepEqual(readClaude({ exit: 1, stdout: '' }), { state: 'unknown' });
  assert.deepEqual(readClaude({ exit: 1, stdout: run('claude-signed-in').stdout }), { state: 'unknown' }, 'exit and JSON disagree');
  assert.deepEqual(readClaude({ exit: 0, stdout: run('claude-signed-out').stdout }), { state: 'unknown' }, 'exit and JSON disagree');
  assert.deepEqual(readClaude({ exit: null, stdout: '' }), { state: 'unknown' }, 'stopped before it exited');
});

test('Codex reads by its exit code alone', () => {
  assert.deepEqual(readCodex(run('codex-signed-in')), { state: 'signed-in' });
  assert.deepEqual(readCodex(run('codex-signed-out')), { state: 'signed-out' });
  assert.deepEqual(readCodex({ exit: 2, stdout: '' }), { state: 'unknown' });
  assert.deepEqual(readCodex({ exit: null, stdout: '' }), { state: 'unknown' });
});

test('Kiro signed in keeps its account type as the method; with an empty home it’s signed out', () => {
  assert.deepEqual(readKiro(run('kiro-signed-in')), { state: 'signed-in', method: 'BuilderId' });
  assert.deepEqual(readKiro(run('kiro-signed-out')), { state: 'signed-out' });
});

test('Kiro output that isn’t a JSON object is unknown, whatever its exit', () => {
  assert.deepEqual(readKiro({ exit: 0, stdout: 'Logged in as robin' }), { state: 'unknown' });
  assert.deepEqual(readKiro({ exit: 1, stdout: 'error: unexpected argument --format' }), { state: 'unknown' });
  assert.deepEqual(readKiro({ exit: 0, stdout: '[]' }), { state: 'unknown' });
  assert.deepEqual(readKiro({ exit: 3, stdout: run('kiro-signed-out').stdout }), { state: 'unknown' });
});

test('a method that isn’t a short name, or a time that isn’t one, is left out', () => {
  const claude = JSON.parse(run('claude-signed-in').stdout);
  const odd = JSON.stringify({ ...claude, authMethod: claude.email, loginExpiresAt: 'soon' });
  assert.deepEqual(readClaude({ exit: 0, stdout: odd }), { state: 'signed-in', expiresAt: null });
  const kiro = JSON.parse(run('kiro-signed-in').stdout);
  assert.deepEqual(readKiro({ exit: 0, stdout: JSON.stringify({ ...kiro, accountType: kiro.startUrl }) }), { state: 'signed-in' });
});

test('a method name no harness is known to give is left out, so only known names reach the event log', () => {
  const claude = JSON.parse(run('claude-signed-in').stdout);
  for (const authMethod of ['claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'])
    assert.equal(readClaude({ exit: 0, stdout: JSON.stringify({ ...claude, authMethod }) }).method, authMethod, authMethod);
  assert.equal(Object.hasOwn(readClaude({ exit: 0, stdout: JSON.stringify({ ...claude, authMethod: 'Robin_Example' }) }), 'method'), false);
  const kiro = JSON.parse(run('kiro-signed-in').stdout);
  for (const accountType of ['BuilderId', 'IamIdentityCenter', 'ExternalIdP', 'ApiKey'])
    assert.equal(readKiro({ exit: 0, stdout: JSON.stringify({ ...kiro, accountType }) }).method, accountType, accountType);
  assert.deepEqual(readKiro({ exit: 0, stdout: JSON.stringify({ ...kiro, accountType: 'claude.ai' }) }), { state: 'signed-in' }, 'another harness’s name');
});
