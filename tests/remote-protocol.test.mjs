// The remote host protocol (shared/remote-protocol.mjs): framing, every message’s validator, the turn folder’s records,
// and a round trip through the fake daemon (tests/fake-daemon.mjs) that wave 2 tests against.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import {
  CHANNEL_NAMES,
  createLineReader,
  createMessageReader,
  encode,
  HOST_DEFAULTS,
  HOST_ENFORCED,
  hostPaths,
  MESSAGE_FILE,
  message,
  messageTypes,
  PROTOCOL_VERSION,
  parseLine,
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
import { createFakeDaemon, FAKE_TOKEN, FIXTURE_PROMPT, fixtureLines, readMessages } from './fake-daemon.mjs';

const TOKEN = 'a'.repeat(43);
const exit = { code: 0, signal: null, at: 1_760_000_000_000 };
const request = { tool_name: 'Bash', input: { command: 'echo hi > note.txt' }, tool_use_id: 'toolu_01' };
const item = { id: 'it_1', line: 'You (@coder): hi', text: 'You (@coder): hi' };
const start = {
  turn: 't1',
  harness: 'claude-code',
  folder: '/home/user/project',
  argv: ['-p', '--output-format', 'stream-json'],
  env: { KIRO_HOME: '/home/user/.postbox-remote/kiro' },
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
};
const welcome = {
  version: PROTOCOL_VERSION,
  home: '/home/user',
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [
    { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.296', looked: [] },
    { name: 'codex', path: null, version: null, looked: ['/usr/local/bin'] },
  ],
  problems: [{ code: 'linger-off', message: 'Turns end when your last session on this host does. Run loginctl enable-linger to keep them.' }],
  turns: [
    { turn: 't0', harness: 'claude-code', state: 'ended', size: 10, exit },
    { turn: 't9', harness: 'codex', state: 'interrupted', size: 0, exit: null },
  ],
};

/**
 * One valid message per type on every channel, and refused variants with the reason each must give. Each refused
 * variant is the valid one with one thing wrong, so the reason is the only difference.
 * @type {Record<string, Record<string, { ok: object, bad: [object, RegExp][] }>>}
 */
const CASES = {
  'postbox-to-daemon': {
    hello: {
      ok: {
        version: 1,
        token: TOKEN,
        takeover: true,
        settings: { permissionWaitMax: 60_000, claudePath: '/opt/claude', codexPath: null, detach: 'setsid', signInCheck: ['klist', '-s'] },
      },
      bad: [
        [{ version: '1', token: TOKEN }, /hello\.version must be a whole number/],
        [{ version: 1, token: 'short' }, /hello\.token must be the host’s token/],
        [{ version: 1 }, /hello needs “token”/],
        [{ version: 1, token: TOKEN, settings: { permissionWaitMax: 10 } }, /hello\.settings: permissionWaitMax must be 1 min to 24 h/],
        [{ version: 1, token: TOKEN, settings: { codexPath: 'codex' } }, /codexPath must be an absolute path/],
        [{ version: 1, token: TOKEN, settings: { codexPath: '/opt/codex/' } }, /hello\.settings: codexPath can’t end with “\/”/],
        [{ version: 1, token: TOKEN, settings: { stall: 1 } }, /“stall” isn’t a field of hello\.settings/],
        [{ version: 1, token: TOKEN, settings: { stallTimeout: 600_000 } }, /“stallTimeout” isn’t a field of hello\.settings/],
      ],
    },
    start: {
      ok: start,
      bad: [
        [{ ...start, folder: 'project' }, /start\.folder must be an absolute path on the host/],
        [{ ...start, folder: '/home/user/\0x' }, /start\.folder can’t contain control characters/],
        [{ ...start, folder: '/home/user/../root' }, /start\.folder can’t contain “\.\.”/],
        [{ ...start, folder: '/home/user/./x' }, /start\.folder can’t contain a “\.” part/],
        [{ ...start, folder: '/home//user' }, /start\.folder can’t contain “\/\/”/],
        [{ ...start, folder: '/home/user/' }, /start\.folder can’t end with “\/”/],
        [{ ...start, folder: '/home/user\nproject' }, /control characters/],
        [{ ...start, harness: 'agy' }, /start\.harness must be one of claude-code, kiro-cli, codex/],
        [{ ...start, argv: '-p' }, /start\.argv must be a list/],
        [{ ...start, argv: ['-p', 3] }, /start\.argv\[1\] must be text/],
        [{ ...start, argv: ['a\0b'] }, /start\.argv\[0\] can’t contain a NUL/],
        [{ ...start, argv: ['x'.repeat(128 * 1024)] }, /Linux limits one argument to 128 KiB/],
        [{ ...start, env: { 'bad-name': 'x' } }, /isn’t a variable name/],
        [{ ...start, env: { '1X': 'x' } }, /isn’t a variable name/],
        [{ ...start, env: { HOME: 1 } }, /start\.env\.HOME must be text/],
        [{ ...start, env: ['A=1'] }, /start\.env must be an object/],
        [{ ...start, stdin: 'pipe' }, /start\.stdin must be one of file, none, held/],
        [{ ...start, files: [{ name: '../x', text: '' }, ...start.files] }, /plain file name/],
        [{ ...start, files: [{ name: 'a/b', text: '' }, ...start.files] }, /plain file name/],
        [{ ...start, files: [{ name: 'a..b', text: '' }, ...start.files] }, /plain file name/],
        [{ ...start, files: [{ name: 'exit.json', text: '{}' }, ...start.files] }, /one of the turn folder’s own files/],
        [{ ...start, files: [...start.files, ...start.files] }, /names the file “message\.jsonl” twice/],
        [{ ...start, files: [{ name: 'x', text: 'y', mode: 0o777 }] }, /“mode” isn’t a field/],
        [{ ...start, files: [] }, /must send message\.jsonl in start\.files/],
        [{ ...start, turn: 'a/b' }, /start\.turn must be a turn ID/],
        [{ ...start, turn: 'x'.repeat(37) }, /start\.turn must be a turn ID/],
        [{ ...start, cwd: '/' }, /“cwd” isn’t a field of start/],
      ],
    },
    snapshot: {
      ok: { turn: 't1', home: 'th_1', threads: [{ id: 'th_1', items: [item, { ...item, id: 'it_2', blockId: 'pick' }] }] },
      bad: [
        [{ turn: 't1', home: 'th_2', threads: [{ id: 'th_1', items: [] }] }, /snapshot\.home “th_2” must be one of snapshot\.threads/],
        [{ turn: 't1', home: 'th_1', threads: [{ id: 'th_1', items: [item, item] }] }, /names the item “it_1” twice/],
        [{ turn: 't1', home: 'th_1', threads: [{ id: 'th_1', items: [{ id: 'x', line: 1, text: '' }] }] }, /items\[0\]\.line must be text/],
        [
          { turn: 't1', home: 'th_1', threads: [{ id: 'th_1', items: [{ ...item, line: 'x'.repeat(REMOTE_LIMITS.snapshotLineChars + 1) }] }] },
          /the limit is 2300/,
        ],
      ],
    },
    'snapshot-items': {
      ok: { turn: 't1', thread: 'th_1', items: [item] },
      bad: [[{ turn: 't1', thread: 'th 1', items: [] }, /snapshot-items\.thread must be an ID/]],
    },
    read: {
      ok: { turn: 't1', from: 0, log: 'in' },
      bad: [
        [{ turn: 't1', from: -1 }, /read\.from must be from 0/],
        [{ turn: 't1', from: 1.5 }, /read\.from must be a whole number/],
        [{ turn: 't1', from: 0, log: 'err' }, /read\.log must be one of out, in/],
      ],
    },
    write: {
      ok: { turn: 't1', line: '{"id":3,"result":{"decision":"accept"}}' },
      bad: [[{ turn: 't1', line: 'a\nb' }, /can’t contain a newline/]],
    },
    answer: {
      ok: { turn: 't1', prompt: 'prompt-1', result: { behavior: 'allow', updatedInput: { command: 'ls' } } },
      bad: [
        [{ prompt: 'prompt-1', result: { behavior: 'deny', message: 'no' } }, /answer needs “turn”/],
        [{ turn: 't1', prompt: 'prompt-1', result: { behavior: 'ask' } }, /behavior must be allow or deny/],
        [{ turn: 't1', prompt: 'prompt-1', result: { behavior: 'deny', message: '' } }, /message can’t be empty/],
        [{ turn: 't1', prompt: 'prompt-1', result: { behavior: 'allow' } }, /needs “updatedInput”/],
      ],
    },
    reply: {
      ok: { turn: 't1', id: 'tool-1', ok: true, text: 'Found 3 passages.' },
      bad: [
        [{ id: 'tool-1', ok: true, text: '' }, /reply needs “turn”/],
        [{ turn: 't1', id: 'tool-1', ok: 'yes', text: '' }, /reply\.ok must be true or false/],
      ],
    },
    stop: { ok: { turn: 't1' }, bad: [[{}, /stop needs “turn”/]] },
    ack: { ok: { turn: 't1', upTo: 120 }, bad: [[{ turn: 't1', upTo: '120' }, /ack\.upTo must be a whole number/]] },
    remove: { ok: {}, bad: [[{ force: true }, /“force” isn’t a field of remove/]] },
  },
  'daemon-to-postbox': {
    welcome: {
      ok: welcome,
      bad: [
        [{ ...welcome, home: '~' }, /welcome\.home must be an absolute path/],
        [{ ...welcome, harnesses: [{ name: 'claude', path: null, version: null, looked: [] }] }, /harnesses\[0\]\.name must be one of/],
        [{ ...welcome, harnesses: [welcome.harnesses[0], welcome.harnesses[0]] }, /names the harness “claude-code” twice/],
        [{ ...welcome, turns: [{ ...welcome.turns[0], exit: null }] }, /turns\[0\]\.exit must be an object/],
        [{ ...welcome, turns: [{ ...welcome.turns[1], exit }] }, /exit must be null unless the turn has ended/],
        [{ ...welcome, problems: [{ code: 'x', message: '' }] }, /message can’t be empty/],
      ],
    },
    started: { ok: { turn: 't1' }, bad: [[{ turn: '' }, /started\.turn must be a turn ID/]] },
    line: {
      ok: { turn: 't1', offset: 0, next: 6, text: 'héllo' },
      bad: [
        [{ turn: 't1', offset: 0, next: 5, text: 'hello!' }, /line\.next must be 7/],
        [{ turn: 't1', offset: 0, next: 5, text: 'hi', cut: false }, /line\.cut is only ever true/],
        [{ turn: 't1', offset: 0, next: 5, text: 'hi', cut: true }, /A cut line’s text must be empty/],
        [{ turn: 't1', offset: 4, next: 4, text: '', cut: true }, /must move the offset on/],
        [{ turn: 't1', offset: 0, next: 4, text: 'a\nb' }, /can’t contain a newline/],
      ],
    },
    written: { ok: { turn: 't1', upTo: 40 }, bad: [[{ turn: 't1', upTo: 0 }, /written\.upTo must be from 1/]] },
    ended: {
      ok: { turn: 't1', exit: null, size: 0 },
      bad: [
        [{ turn: 't1', exit: { code: 0, signal: 'SIGINT', at: 1 }, size: 0 }, /a code or a signal, never both or neither/],
        [{ turn: 't1', exit: { code: null, signal: 'INT', at: 1 }, size: 0 }, /signal must be a signal name/],
      ],
    },
    tool: {
      ok: { turn: 't1', id: 'tool-1', name: 'show_block', args: { block: {} } },
      bad: [
        [{ turn: 't1', id: 'tool-1', name: 'read_message', args: {} }, /isn’t a tool Postbox answers/],
        [{ turn: 't1', id: 'tool-1', name: 'constructor', args: {} }, /isn’t a tool Postbox answers/],
        [{ turn: 't1', id: 'tool-1', name: 'show_block', args: [] }, /tool\.args must be an object/],
      ],
    },
    prompt: {
      ok: { id: 'prompt-1', turn: 't1', request },
      bad: [
        [{ id: 'prompt-1', turn: 't1', request: { tool_name: 'Bash' } }, /request needs “input”/],
        [{ id: 'prompt-1', turn: 't1', request: { ...request, tool_use_id: 7 } }, /prompt\.request\.tool_use_id must be text/],
      ],
    },
    'prompt-expired': { ok: { id: 'prompt-1', turn: 't1', at: 5 }, bad: [[{ id: 'prompt-1', turn: 't1' }, /needs “at”/]] },
    removed: { ok: {}, bad: [[{ turns: 2 }, /“turns” isn’t a field of removed/]] },
    error: {
      ok: { code: 'bad-offset', message: '7 isn’t the start of a line.', re: 'read', turn: 't1' },
      bad: [
        [{ code: 'oops', message: 'x' }, /error\.code must be one of/],
        [{ code: 'internal', message: '' }, /error\.message can’t be empty/],
      ],
    },
  },
  'daemon-to-runner': {
    who: { ok: { token: TOKEN }, bad: [[{}, /who needs “token”/]] },
    stdin: { ok: { line: '{"id":1}' }, bad: [[{ line: 1 }, /stdin\.line must be text/]] },
  },
  'runner-to-daemon': {
    iam: { ok: { turn: 't1', pid: 4242 }, bad: [[{ turn: 't1', pid: 1 }, /iam\.pid must be from 2/]] },
    written: { ok: { upTo: 9 }, bad: [[{ upTo: -1 }, /written\.upTo must be from 1/]] },
    error: { ok: { code: 'bad-token', message: 'Wrong token.' }, bad: [[{ code: 'bad-token' }, /error needs “message”/]] },
  },
  'shim-to-daemon': {
    hello: { ok: { token: TOKEN, turn: 't1' }, bad: [[{ token: TOKEN }, /hello needs “turn”/]] },
    call: {
      ok: { id: 'c1', name: 'read_conversation', args: { limit: 5 } },
      bad: [
        [{ id: 'c1', name: 'permission_prompt', args: {} }, /isn’t a Postbox tool the daemon serves/],
        [{ id: 'c1', name: 'Bash', args: {} }, /isn’t a Postbox tool the daemon serves/],
      ],
    },
    permission: { ok: { id: 'p1', request }, bad: [[{ id: 'p1', request: { tool_name: '', input: {} } }, /tool_name can’t be empty/]] },
    'permission-expired': { ok: { id: 'p1', at: 1 }, bad: [[{ id: 'p1', at: 'now' }, /at must be a whole number/]] },
  },
  'daemon-to-shim': {
    welcome: {
      ok: { turn: 't1', permissionWaitMax: 86_400_000 },
      bad: [[{ turn: 't1', permissionWaitMax: 0 }, /welcome\.permissionWaitMax must be from 60000/]],
    },
    result: {
      ok: { id: 'c1', ok: false, text: 'Postbox isn’t connected, so the corpus can’t be searched now.' },
      bad: [[{ id: 'c1', ok: false }, /needs “text”/]],
    },
    'permission-answer': {
      ok: { id: 'p1', result: { behavior: 'deny', message: 'The person didn’t allow this.' } },
      bad: [[{ id: 'p1', result: { behavior: 'deny', message: 'no', updatedInput: {} } }, /“updatedInput” isn’t a field/]],
    },
    error: { ok: { code: 'turn-ended', message: 'This turn has ended.' }, bad: [[{ code: 'turn-ended', message: 'x', at: 1 }, /“at” isn’t a field of error/]] },
  },
};

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
  const r = validateMessage('postbox-to-daemon', { type: 'hello', version: 1, token: TOKEN, settings: structuredClone(HOST_DEFAULTS) });
  assert.ok(r.ok, r.ok ? '' : r.error);
});

test('the module imports only shared/ and no node: module, since it ships to the host and loads in the browser', () => {
  const src = readFileSync(new URL('../shared/remote-protocol.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'found no imports to check');
  for (const i of imports) assert.match(i, /^\.\/[a-z-]+\.mjs$/, i);
});

// ── Framing ─────────────────────────────────────────────────────────────────────────

/** A line reader that records what it gives. @param {object} [opts] */
const lines = (opts = {}) => {
  const got = [];
  const errors = [];
  const r = createLineReader({ onLine: (text, span) => got.push({ text, ...span }), onError: (e) => errors.push(e), ...opts });
  return { r, got, errors };
};

test('encode writes one message per line, and parseLine reads it back', () => {
  const line = encode(message('postbox-to-daemon', 'write', { turn: 't1', line: 'a "quoted"\ttext' }));
  assert.equal(line.indexOf('\n'), line.length - 1, 'one \\n, at the end');
  const r = parseLine('postbox-to-daemon', line.slice(0, -1));
  assert.ok(r.ok);
  assert.equal(r.ok && r.msg.line, 'a "quoted"\ttext');
});

test('lines split across chunks, even inside a multi-byte character, come out whole with byte offsets', () => {
  const { r, got, errors } = lines();
  const bytes = new TextEncoder().encode('héllo\n\nwörld\n');
  for (const b of bytes) r.push(Uint8Array.of(b));
  assert.deepEqual(errors, []);
  assert.deepEqual(got, [
    { text: 'héllo', offset: 0, next: 7 },
    { text: '', offset: 7, next: 8 },
    { text: 'wörld', offset: 8, next: 15 },
  ]);
});

test('a line over the limit is reported once and skipped, and the next line is read', () => {
  const { r, got, errors } = lines({ maxBytes: 8 });
  r.push('short\n0123');
  r.push('456789 and more\nok\n');
  assert.deepEqual(
    got.map((g) => g.text),
    ['short', 'ok'],
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'too-long');
  assert.equal(errors[0].offset, 6);
  assert.equal(got[1].offset, 6 + 'abcdefghij and more'.length + 1, 'offsets still count the skipped bytes');
});

test('a line that isn’t UTF-8 is reported and skipped', () => {
  const { r, got, errors } = lines();
  r.push(Uint8Array.of(0xff, 0xfe, 0x0a, 0x6f, 0x6b, 0x0a));
  assert.deepEqual(
    got.map((g) => g.text),
    ['ok'],
  );
  assert.equal(errors[0].code, 'bad-utf8');
});

test('input that ends mid-line is torn on a channel, and delivered as the last line of a finished log', () => {
  const torn = lines();
  torn.r.push('{"type":"remove"}\n{"type":');
  torn.r.end();
  assert.equal(torn.got.length, 1);
  assert.equal(torn.errors[0].code, 'torn');
  const log = lines({ trailing: true, offset: 100 });
  log.r.push('a\nlast');
  log.r.end();
  assert.deepEqual(log.got.at(-1), { text: 'last', offset: 102, next: 106 }, 'next is the file’s size, with no \\n');
});

test('the message reader reports bad JSON and refused messages, never throws, and reads on', () => {
  const got = [];
  const errors = [];
  const r = createMessageReader('postbox-to-daemon', { onMessage: (m) => got.push(m), onError: (e) => errors.push(e) });
  assert.doesNotThrow(() => r.push('not json\n{"type":"launch"}\n{"type":"stop","turn":"t1"}\n'));
  assert.deepEqual(got, [{ type: 'stop', turn: 't1' }]);
  assert.deepEqual(
    errors.map((e) => e.code),
    ['bad-json', 'bad-message'],
  );
  assert.equal(errors[1].offset, 9);
});

test('encode refuses a message over the line limit, and utf8Bytes counts as TextEncoder does', () => {
  assert.throws(() => encode({ type: 'reply', id: 'x', ok: true, text: 'x'.repeat(REMOTE_LIMITS.lineBytes) }), { name: 'RangeError' });
  for (const s of ['', 'abc', 'héllo', '日本', '👋🏽', '\ud800x', 'a\udc00']) assert.equal(utf8Bytes(s), new TextEncoder().encode(s).length, JSON.stringify(s));
});

// ── The fake daemon ─────────────────────────────────────────────────────────────────

/** Postbox’s side of a connection to the fake. @param {{ stdin: any, stdout: any }} conn */
const client = ({ stdin, stdout }) => {
  const r = readMessages(stdout);
  return { ...r, send: (type, body = {}) => stdin.write(encode(message('postbox-to-daemon', type, body))) };
};
const FIXTURE = readFileSync(new URL('./fixtures/claude-code/permission-allow.jsonl', import.meta.url), 'utf8');
const FIXTURE_BYTES = Buffer.from(FIXTURE, 'utf8');

test('the fake daemon refuses a wrong token, then welcomes the right one with the harnesses it has', async () => {
  const d = createFakeDaemon({ harnesses: ['claude-code'] });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: 'b'.repeat(40) });
  assert.equal((await c.next('error')).code, 'bad-token');
  c.send('stop', { turn: 't1' });
  assert.equal((await c.next('error')).code, 'not-ready', 'nothing but hello before a good hello');
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await c.next('welcome');
  assert.equal(w.home, '/home/user');
  assert.deepEqual(
    w.harnesses.map((h) => [h.name, h.path !== null]),
    [
      ['claude-code', true],
      ['kiro-cli', false],
      ['codex', false],
    ],
  );
});

test('a turn on the fake replays the recorded stream with the byte offsets out.jsonl would have, then ends', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  c.send('start', start);
  c.send('read', { turn: 't1', from: 0 });
  assert.equal((await c.next('started')).turn, 't1');
  const ended = await c.next('ended');
  const got = c.messages.filter((m) => m.type === 'line');
  assert.equal(got.length, fixtureLines().length);
  assert.equal(got.map((l) => `${l.text}\n`).join(''), FIXTURE, 'the lines are the fixture, byte for byte');
  for (const l of got) assert.equal(FIXTURE_BYTES.subarray(l.offset, l.next - 1).toString('utf8'), l.text);
  assert.deepEqual(ended.exit, { code: 0, signal: null, at: 1_760_000_000_000 });
  assert.equal(ended.size, FIXTURE_BYTES.length);
  assert.equal(got.at(-1).next, ended.size);
  assert.match(JSON.parse(got.at(-2).text).result, /^I ran `echo hello > hello\.txt`/, 'the result is the recorded one');
});

test('a read from a line’s offset replays from there, and an offset inside a line is refused', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  await c.next('started');
  const third = d.turns.get('t1').out[2];
  c.send('read', { turn: 't1', from: third.offset });
  await c.next('ended');
  const got = c.messages.filter((m) => m.type === 'line');
  assert.equal(got[0].offset, third.offset);
  assert.equal(got.length, fixtureLines().length - 2);
  c.send('read', { turn: 't1', from: third.offset + 1 });
  const e = await c.next('error');
  assert.deepEqual([e.code, e.re, e.turn], ['bad-offset', 'read', 't1']);
});

test('a running turn on the fake follows appended lines, records the ack, and a stop ends it with SIGINT', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: fixtureLines().slice(0, 2) });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  c.send('read', { turn: 't1', from: 0 });
  await c.next('line');
  const second = await c.next('line');
  d.append('t1', '{"type":"system","subtype":"status"}');
  const third = await c.next('line');
  assert.equal(third.offset, second.next);
  c.send('ack', { turn: 't1', upTo: third.next });
  c.send('stop', { turn: 't1' });
  const ended = await c.next('ended');
  assert.deepEqual(d.stops, ['t1']);
  assert.equal(d.turns.get('t1').acked, third.next);
  assert.deepEqual([ended.exit.code, ended.exit.signal, ended.size], [null, 'SIGINT', third.next]);
});

test('tools and prompts queued while Postbox is away arrive after it reconnects, and leave the queue when answered', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const first = client(d);
  first.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  first.send('start', start);
  await first.next('started');
  d.drop();
  await first.ended;
  const tool = d.tool('t1', 'show_block', { block: { id: 'pick', type: 'choice' } });
  const prompt = d.prompt('t1');
  const late = d.prompt('t1', { tool_name: 'Write', input: { file_path: '/home/user/x' } });
  d.expire('t1', late);
  const again = client(d.connect());
  again.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await again.next('welcome');
  assert.deepEqual(w.turns, [{ turn: 't1', harness: 'claude-code', state: 'running', size: FIXTURE_BYTES.length, exit: null }]);
  assert.equal((await again.next('tool')).id, tool);
  const p = await again.next('prompt');
  assert.deepEqual([p.id, p.request], [prompt, FIXTURE_PROMPT]);
  assert.equal(again.messages.filter((m) => m.type === 'prompt').length, 1, 'an expired prompt isn’t resent');
  again.send('reply', { turn: 't1', id: tool, ok: true, text: 'Shown.' });
  again.send('answer', { turn: 't1', prompt, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  again.send('answer', { turn: 't1', prompt, result: { behavior: 'deny', message: 'Too late.' } });
  assert.equal((await again.next('error')).code, 'no-prompt', 'a prompt is answered once');
  assert.deepEqual(d.queued, { tools: [], prompts: [] });
});

test('a prompt expiring while Postbox is connected is sent as prompt-expired', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  const id = d.prompt('t1');
  await c.next('prompt');
  d.expire('t1', id);
  assert.deepEqual(await c.next('prompt-expired'), { type: 'prompt-expired', id, turn: 't1', at: 1_760_000_000_000 });
});

test('a held stdin takes writes, says where in.jsonl got to, and serves in.jsonl to a read with log: in', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', { ...start, harness: 'codex', stdin: 'held', files: [] });
  const req = '{"id":1,"method":"initialize","params":{}}';
  c.send('write', { turn: 't1', line: req });
  assert.deepEqual(await c.next('written'), { type: 'written', turn: 't1', upTo: req.length + 1 });
  c.send('read', { turn: 't1', from: 0, log: 'in' });
  const l = await c.next('line');
  assert.deepEqual([l.log, l.text], ['in', req]);
  c.send('start', { ...start, turn: 't2' });
  c.send('write', { turn: 't2', line: req });
  assert.equal((await c.next('error')).code, 'not-held', 'a file stdin takes no writes');
});

test('a second Postbox is refused as busy unless it takes over, and the first is told', async () => {
  const d = createFakeDaemon();
  const first = client(d);
  first.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await first.next('welcome');
  const second = client(d.connect());
  second.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  assert.equal((await second.next('error')).code, 'busy');
  second.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN, takeover: true });
  await second.next('welcome');
  assert.equal((await first.next('error')).code, 'taken-over');
  await first.ended;
});

test('the fake refuses a malformed line with bad-message and goes on serving the connection', async () => {
  const d = createFakeDaemon();
  const c = client(d);
  d.stdin.write('{"type":"start","turn":"t1","folder":"relative"}\n');
  const e = await c.next('error');
  assert.equal(e.code, 'bad-message');
  assert.match(e.message, /start needs “harness”|start\.folder/);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  await c.next('welcome');
  assert.equal(d.errors.length, 1);
});

test('a turn already on the host shows in welcome, and a restarted Postbox replays it from offset 0', async () => {
  const d = createFakeDaemon();
  d.addTurn('old', { exit: { code: 0, signal: null } });
  d.addTurn('lost', { harness: 'kiro-cli', stdin: 'none', lines: [], interrupted: true });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  const w = await c.next('welcome');
  assert.deepEqual(
    w.turns.map((t) => [t.turn, t.state]),
    [
      ['old', 'ended'],
      ['lost', 'interrupted'],
    ],
  );
  c.send('read', { turn: 'lost', from: 0 });
  assert.deepEqual(await c.next('ended'), { type: 'ended', turn: 'lost', exit: null, size: 0 });
  c.send('read', { turn: 'old', from: 0 });
  assert.equal((await c.next('ended')).turn, 'old');
  assert.equal(c.messages.filter((m) => m.type === 'line' && m.turn === 'old').length, fixtureLines().length);
});

test('remove ends every turn, answers removed and closes the connection', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  await c.next('started');
  c.send('remove');
  await c.next('removed');
  await c.ended;
  assert.equal(d.turns.size, 0);
});

test('two turns whose shims both use ID 1 each get only their own answer and reply', async () => {
  const d = createFakeDaemon({ autoEnd: false });
  const c = client(d);
  c.send('hello', { version: PROTOCOL_VERSION, token: FAKE_TOKEN });
  c.send('start', start);
  c.send('start', { ...start, turn: 't2' });
  await c.next('started');
  await c.next('started');
  const write = { tool_name: 'Write', input: { file_path: '/home/user/x' } };
  assert.equal(d.prompt('t1', FIXTURE_PROMPT, '1'), '1');
  assert.equal(d.prompt('t2', write, '1'), '1');
  d.tool('t1', 'corpus_search', { query: 'one' }, '1');
  d.tool('t2', 'corpus_search', { query: 'two' }, '1');
  const prompts = [await c.next('prompt'), await c.next('prompt')];
  assert.deepEqual(
    prompts.map((p) => [p.turn, p.id, p.request.tool_name]),
    [
      ['t1', '1', FIXTURE_PROMPT.tool_name],
      ['t2', '1', 'Write'],
    ],
  );
  c.send('answer', { turn: 't2', prompt: '1', result: { behavior: 'deny', message: 'Not that file.' } });
  c.send('reply', { turn: 't1', id: '1', ok: true, text: 'Found one.' });
  c.send('answer', { turn: 't3', prompt: '1', result: { behavior: 'deny', message: 'No such turn.' } });
  const e = await c.next('error');
  assert.deepEqual([e.code, e.turn], ['no-prompt', 't3'], 'an answer for another turn’s ID 1 finds nothing');
  assert.deepEqual(d.queued, { tools: [{ turn: 't2', id: '1' }], prompts: [{ turn: 't1', id: '1' }] });
  assert.deepEqual(
    d.answers.map((a) => [a.turn, a.id, a.result.behavior]),
    [['t2', '1', 'deny']],
  );
  assert.deepEqual(
    d.replies.map((r) => [r.turn, r.id, r.text]),
    [['t1', '1', 'Found one.']],
  );
  c.send('answer', { turn: 't1', prompt: '1', result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  c.send('reply', { turn: 't2', id: '1', ok: true, text: 'Found two.' });
  c.send('answer', { turn: 't1', prompt: '1', result: { behavior: 'deny', message: 'Again.' } });
  assert.equal((await c.next('error')).code, 'no-prompt', 'each turn’s prompt is answered once');
  assert.deepEqual(
    d.answers.map((a) => [a.turn, a.result.behavior]),
    [
      ['t2', 'deny'],
      ['t1', 'allow'],
    ],
  );
  assert.deepEqual(
    d.replies.map((r) => [r.turn, r.text]),
    [
      ['t1', 'Found one.'],
      ['t2', 'Found two.'],
    ],
  );
  assert.deepEqual(d.queued, { tools: [], prompts: [] });
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
    const h = validateMessage('postbox-to-daemon', { type: 'hello', version: 1, token: TOKEN, settings: { claudePath: path } });
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
