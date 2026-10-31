// The remote host protocol (shared/remote-protocol.mjs): every message’s validator, the turn folder’s records and the
// host’s paths. Its framing is in remote-protocol-framing.test.mjs, a round trip through the fake daemon
// (tests/fake-daemon.mjs) that wave 2 tests against in remote-protocol-fake-daemon.test.mjs, and the cases these share
// in remote-protocol-cases.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import {
  CHANNEL_NAMES,
  ERROR_CODES,
  HOST_DEFAULTS,
  HOST_ENFORCED,
  hostPaths,
  message,
  messageTypes,
  PROTOCOL_VERSION,
  REMOTE_LIMITS,
  socketPathFits,
  TOOL_ROUTES,
  TURN_FILES,
  utf8Bytes,
  VALIDATORS,
  validateExitRecord,
  validateMessage,
  validateRunnerRecord,
  validateStartRecord,
} from '../shared/remote-protocol.mjs';
import { checkHostPath, defaultHostSettings } from '../shared/remote-settings.mjs';
import { CASES, request, start, TOKEN } from './remote-protocol-cases.mjs';

// ── Validators ──────────────────────────────────────────────────────────────────────

test('every message type on every channel has a valid case and at least one refused case here', () => {
  for (const ch of CHANNEL_NAMES) assert.deepEqual(Object.keys(CASES[ch] ?? {}).sort(), messageTypes(ch).sort(), ch);
  for (const ch of CHANNEL_NAMES) for (const [type, c] of Object.entries(CASES[ch])) assert.ok(c.bad.length > 0, `${ch} ${type}`);
});

for (const [ch, types] of Object.entries(CASES))
  for (const [type, { ok, bad }] of Object.entries(types)) {
    test(`${ch} ${type}: a valid one passes, and each malformed one is refused with its reason`, () => {
      const v = VALIDATORS[/** @type {any} */ (ch)][type];
      const good = v({ type, ...ok });
      assert.ok(good.ok, `${type} should pass: ${good.ok ? '' : good.error}`);
      for (const [m, reason] of bad) {
        const r = v({ type, ...m });
        assert.equal(r.ok, false, `${type} ${JSON.stringify(m).slice(0, 120)} should be refused`);
        assert.match(r.ok ? '' : r.error, reason);
      }
    });
  }

test('an unknown message type is refused, and the reason lists what the channel carries', () => {
  const r = validateMessage('postbox-to-daemon', { type: 'exec', command: 'rm -rf ~' });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /“exec” isn’t a message on this channel; it carries hello, start/);
  assert.equal(validateMessage('postbox-to-daemon', { type: 'constructor' }).ok, false, 'an inherited name isn’t a type');
  assert.equal(validateMessage('daemon-to-postbox', { type: 'start', ...start }).ok, false, 'a message is checked for its own direction');
  assert.equal(validateMessage('postbox-to-daemon', [{ type: 'remove' }]).ok, false);
  assert.equal(validateMessage('postbox-to-daemon', null).ok, false);
});

test('a validator for one type refuses a valid message of another type', () => {
  const r = VALIDATORS['postbox-to-daemon'].stop({ type: 'remove' });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /must be an object with type “stop”/);
});

test('message() builds a valid message and throws on a refused one, naming the field', () => {
  assert.deepEqual(message('postbox-to-daemon', 'stop', { turn: 't1' }), { type: 'stop', turn: 't1' });
  assert.throws(() => message('postbox-to-daemon', 'stop', { turn: '../t1' }), { name: 'TypeError', message: /stop\.turn must be a turn ID/ });
});

test('every Postbox tool has a route on the host, and nothing else does', () => {
  assert.deepEqual(Object.keys(TOOL_ROUTES).sort(), TOOL_DEFS.map((t) => t.name).sort());
  assert.equal(TOOL_ROUTES.permission_prompt, 'host');
  assert.equal(TOOL_ROUTES.corpus_search, 'ask');
  assert.equal(TOOL_ROUTES.review_block, 'ask');
  assert.equal(TOOL_ROUTES.read_conversation, 'read');
  assert.equal(TOOL_ROUTES.read_message, 'read');
  // A second react takes it back, so only Postbox’s answer says which it was.
  assert.equal(TOOL_ROUTES.react, 'ask');
});

test('a file Postbox sends may not take the name of any of the turn folder’s own files', () => {
  for (const name of Object.values(TURN_FILES)) {
    const r = validateMessage('postbox-to-daemon', { type: 'start', ...start, files: [...start.files, { name, text: '' }] });
    assert.equal(r.ok, false, name);
  }
});

test('argv and files are refused over their total limits, not only per entry', () => {
  const arg = 'x'.repeat(100 * 1024);
  const argv = validateMessage('postbox-to-daemon', { type: 'start', ...start, argv: Array(11).fill(arg) });
  assert.match(argv.ok ? '' : argv.error, /start\.argv is \d+ bytes in all/);
  const text = 'y'.repeat(3 * 1024 * 1024);
  const files = validateMessage('postbox-to-daemon', {
    type: 'start',
    ...start,
    files: [...start.files, { name: 'a', text }, { name: 'b', text }, { name: 'c', text }],
  });
  assert.match(files.ok ? '' : files.error, /start\.files are over \d+ bytes in all/);
});

test('exit.json has a code or a signal and a time; runner.json has the PID, boot ID and start time', () => {
  assert.ok(validateExitRecord({ code: 0, signal: null, at: 1 }).ok);
  assert.ok(validateExitRecord({ code: null, signal: 'SIGKILL', at: 1 }).ok);
  assert.match(String(/** @type {any} */ (validateExitRecord({ code: null, signal: null, at: 1 })).error), /never both or neither/);
  assert.match(String(/** @type {any} */ (validateExitRecord({ code: 256, signal: null, at: 1 })).error), /code must be from 0 to 255/);
  const runner = { turn: 't1', version: '0.10.0', pid: 4242, bootId: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', startTime: 123456 };
  assert.ok(validateRunnerRecord(runner).ok);
  assert.match(String(/** @type {any} */ (validateRunnerRecord({ ...runner, bootId: 'not-a-uuid' })).error), /bootId must be the boot ID/);
  assert.match(String(/** @type {any} */ (validateRunnerRecord({ ...runner, pid: '4242' })).error), /pid must be a whole number/);
  assert.match(String(/** @type {any} */ (validateRunnerRecord({ ...runner, startTime: undefined })).error), /needs “startTime”/);
});

test('PROTOCOL_VERSION is 3: remote reads fall back to Postbox', () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.ok(ERROR_CODES.includes('no-node'));
});

test('start.agentFile is a Kiro agent file’s name and text, only for kiro-cli, measured in UTF-8 bytes; the daemon picks its folder', () => {
  const start = { type: 'start', turn: 't1', harness: 'kiro-cli', folder: '/home/user/work', argv: ['chat'], env: {}, stdin: 'none', files: [] };
  const file = { name: 'postbox-a1.json', text: '{}' };
  assert.ok(validateMessage('postbox-to-daemon', { ...start, agentFile: file }).ok);
  // Two bytes a character: under the limit in characters, over it in bytes.
  const wide = 'é'.repeat(REMOTE_LIMITS.fileBytes / 2 + 1);
  assert.ok(wide.length <= REMOTE_LIMITS.fileBytes && utf8Bytes(wide) > REMOTE_LIMITS.fileBytes);
  for (const [bad, why] of [
    [{ ...file, name: '../a.json' }, /plain file name ending in \.json/],
    [{ ...file, name: 'a.txt' }, /ending in \.json/],
    [{ ...file, dir: '/home/user/.kiro/agents' }, /“dir” isn’t a field of start\.agentFile/],
    [{ ...file, text: wide }, new RegExp(`start\\.agentFile\\.text is ${utf8Bytes(wide)} bytes; the limit is ${REMOTE_LIMITS.fileBytes}`)],
  ])
    assert.match(String(/** @type {any} */ (validateMessage('postbox-to-daemon', { ...start, agentFile: bad })).error), why);
  for (const harness of ['claude-code', 'codex'])
    assert.match(
      String(/** @type {any} */ (validateMessage('postbox-to-daemon', { ...start, harness, agentFile: file })).error),
      /start\.agentFile is only for kiro-cli/,
      harness,
    );
});

test('prompt-expired says why', () => {
  const expired = { type: 'prompt-expired', id: 'p1', turn: 't1', at: 1 };
  assert.ok(validateMessage('daemon-to-postbox', expired).ok, 'reason defaults to expired');
  assert.ok(validateMessage('daemon-to-postbox', { ...expired, reason: 'canceled' }).ok);
  assert.match(String(/** @type {any} */ (validateMessage('daemon-to-postbox', { ...expired, reason: 'gone' })).error), /reason/);
});

test('#120 an error about a prompt’s expiry names the prompt within its turn: error.id, which needs error.turn', () => {
  const err = { type: 'error', code: 'internal', re: 'prompt-expired', turn: 't1', message: 'Couldn’t write it down.' };
  assert.ok(validateMessage('daemon-to-postbox', err).ok, 'id is optional, as from an older daemon');
  assert.ok(validateMessage('daemon-to-postbox', { ...err, id: 'codex:7' }).ok);
  const r = (m) => String(/** @type {any} */ (validateMessage('daemon-to-postbox', m)).error);
  assert.match(r({ ...err, id: '' }), /error\.id must be an ID/);
  const { turn: _t, ...noTurn } = err;
  assert.match(r({ ...noTurn, id: 'p1' }), /error\.id names a prompt or a tool call within a turn/);
});

test('#120 G10: turn-stopped is an error code: a start refused because the daemon was asked to stop that turn first', () => {
  assert.ok(ERROR_CODES.includes('turn-stopped'));
  const err = { type: 'error', code: 'turn-stopped', re: 'start', turn: 't1', message: 'Turn t1 was stopped before it started here.' };
  assert.ok(validateMessage('daemon-to-postbox', err).ok);
  assert.match(String(/** @type {any} */ (validateMessage('daemon-to-postbox', { ...err, code: 'turn-stopped-early' })).error), /error\.code/);
});

test('start.json names the harness’s absolute program and the start message’s argv, env, stdin and folder', () => {
  const start = {
    turn: 't1',
    harness: 'claude-code',
    program: '/home/user/.local/bin/claude',
    argv: ['-p'],
    env: {},
    stdin: 'file',
    folder: '/home/user/work',
  };
  assert.ok(validateStartRecord(start).ok);
  assert.match(String(/** @type {any} */ (validateStartRecord({ ...start, program: 'claude' })).error), /start\.json\.program/);
  assert.match(String(/** @type {any} */ (validateStartRecord({ ...start, harness: 'sh' })).error), /start\.json\.harness/);
  assert.match(String(/** @type {any} */ (validateStartRecord({ ...start, files: [] })).error), /files/);
});

test('host paths keep the repo’s layout under the version folder, and turns are shared by every version', () => {
  const p = hostPaths('/home/user', '0.10.0');
  assert.equal(p.host, '/home/user/.postbox-remote/0.10.0/server/remote/host/host');
  assert.equal(p.shim, '/home/user/.postbox-remote/0.10.0/server/remote/host/shim.mjs');
  assert.equal(p.token, '/home/user/.postbox-remote/token');
  assert.equal(p.lock, '/home/user/.postbox-remote/locks/0.10.0.lock', 'outside the version folder the installer renames');
  assert.equal(p.turn('t1', TURN_FILES.out), '/home/user/.postbox-remote/turns/t1/out.jsonl');
  assert.throws(() => p.turn('../x'), /isn’t a turn ID/);
  assert.throws(() => hostPaths('home/user', '0.10.0'), /must be an absolute path/);
  assert.throws(() => hostPaths('/home/user', '../0.10.0'), /isn’t a version/);
});

test('a 36-character turn’s runner socket fits in sun_path under a 43-character home folder', () => {
  const home = `/home/${'u'.repeat(37)}`;
  assert.equal(home.length, 43);
  assert.ok(socketPathFits(hostPaths(home, '0.10.0').turn('t'.repeat(36), TURN_FILES.socket)));
  assert.equal(socketPathFits(hostPaths(`${home}u`, '0.10.0').turn('t'.repeat(36), TURN_FILES.socket)), false);
  assert.equal(socketPathFits(`/${'x'.repeat(107)}`), false);
});

test('hello.settings carries the host-enforced settings, with remote-settings.mjs’s names and defaults', () => {
  const defaults = defaultHostSettings();
  for (const k of HOST_ENFORCED) assert.ok(Object.hasOwn(defaults, k), `${k} is a host setting`);
  assert.deepEqual(Object.keys(HOST_DEFAULTS), [...HOST_ENFORCED]);
  for (const k of HOST_ENFORCED) assert.deepEqual(HOST_DEFAULTS[k], defaults[k], k);
  const r = validateMessage('postbox-to-daemon', { type: 'hello', version: PROTOCOL_VERSION, token: TOKEN, settings: structuredClone(HOST_DEFAULTS) });
  assert.ok(r.ok, r.ok ? '' : r.error);
});

test('the module imports only shared/ and no node: module, since it ships to the host and loads in the browser', () => {
  const src = readFileSync(new URL('../shared/remote-protocol.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'found no imports to check');
  for (const i of imports) assert.match(i, /^\.\/[a-z-]+\.mjs$/, i);
});

test('every path a host’s settings accept passes the protocol’s checks, and a trailing / is refused with why', () => {
  const accepted = [];
  for (const path of [
    '/',
    '/home/user/src/app',
    '/srv/proj/',
    '/srv/./proj',
    '/srv/../proj',
    '//srv',
    '/srv//proj',
    '/srv/proj.d/.hidden/..x',
    `/${'a'.repeat(REMOTE_LIMITS.pathBytes - 1)}`,
    `/${'a'.repeat(REMOTE_LIMITS.pathBytes)}`,
    `/${'é'.repeat(2047)}`,
    `/${'é'.repeat(2048)}`,
  ]) {
    if (!checkHostPath(path, 'folder').ok) continue;
    accepted.push(path);
    const s = validateMessage('postbox-to-daemon', { type: 'start', ...start, folder: path });
    assert.ok(s.ok, `start.folder ${path.slice(0, 40)}: ${s.ok ? '' : s.error}`);
    const h = validateMessage('postbox-to-daemon', { type: 'hello', version: PROTOCOL_VERSION, token: TOKEN, settings: { claudePath: path } });
    assert.ok(h.ok, `hello.settings.claudePath ${path.slice(0, 40)}: ${h.ok ? '' : h.error}`);
  }
  assert.equal(accepted.length, 5, 'the plain paths, and the longest in bytes, pass');
  const r = checkHostPath('/srv/proj/', 'The project’s folder');
  assert.ok(!r.ok);
  assert.match(r.error, /can’t end with “\/”.*\/srv\/proj\b/);
  const big = checkHostPath(`/${'é'.repeat(2048)}`, 'folder');
  assert.ok(!big.ok);
  assert.match(big.error, /over 4095 bytes/);
});

test('a permission request with a field Claude Code added passes, and its known fields are still checked', () => {
  const added = { ...request, permission_suggestions: [{ type: 'addRules' }], blocked_path: '/home/user/x', decision_reason: { type: 'rule' } };
  for (const [ch, type, body] of [
    ['shim-to-daemon', 'permission', { id: 'p1', request: added }],
    ['daemon-to-postbox', 'prompt', { id: 'p1', turn: 't1', request: added }],
  ]) {
    const r = validateMessage(ch, { type, ...body });
    assert.ok(r.ok, `${ch} ${type}: ${r.ok ? '' : r.error}`);
    const bad = validateMessage(ch, { type, ...body, request: { ...added, agent_id: ['x'] } });
    assert.ok(!bad.ok);
    assert.match(bad.error, /request\.agent_id must be text/);
  }
});
