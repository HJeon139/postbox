// The protocol tests’ cases (tests/remote-protocol*.test.mjs): one valid message per type on every channel, the
// refused variants with the reason each must give, and the values they’re built from.

import { MESSAGE_FILE, PROTOCOL_VERSION, REMOTE_LIMITS } from '../shared/remote-protocol.mjs';

export const TOKEN = 'a'.repeat(43);
export const exit = { code: 0, signal: null, at: 1_760_000_000_000 };
export const request = { tool_name: 'Bash', input: { command: 'echo hi > note.txt' }, tool_use_id: 'toolu_01' };
export const item = { id: 'it_1', line: 'You (@coder): hi', text: 'You (@coder): hi' };
export const start = {
  turn: 't1',
  harness: 'claude-code',
  folder: '/home/user/project',
  argv: ['-p', '--output-format', 'stream-json'],
  env: { KIRO_HOME: '/home/user/.postbox-remote/kiro' },
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
};
export const welcome = {
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
export const CASES = {
  'postbox-to-daemon': {
    hello: {
      ok: {
        version: PROTOCOL_VERSION,
        token: TOKEN,
        takeover: true,
        settings: { permissionWaitMax: 60_000, claudePath: '/opt/claude', codexPath: null, detach: 'setsid', signInCheck: ['klist', '-s'] },
      },
      bad: [
        [{ version: '1', token: TOKEN }, /hello\.version must be a whole number/],
        [{ version: PROTOCOL_VERSION, token: 'short' }, /hello\.token must be the host’s token/],
        [{ version: PROTOCOL_VERSION }, /hello needs “token”/],
        [{ version: PROTOCOL_VERSION, token: TOKEN, settings: { permissionWaitMax: 10 } }, /hello\.settings: permissionWaitMax must be 1 min to 24 h/],
        [{ version: PROTOCOL_VERSION, token: TOKEN, settings: { codexPath: 'codex' } }, /codexPath must be an absolute path/],
        [{ version: PROTOCOL_VERSION, token: TOKEN, settings: { codexPath: '/opt/codex/' } }, /hello\.settings: codexPath can’t end with “\/”/],
        [{ version: PROTOCOL_VERSION, token: TOKEN, settings: { stall: 1 } }, /“stall” isn’t a field of hello\.settings/],
        [{ version: PROTOCOL_VERSION, token: TOKEN, settings: { stallTimeout: 600_000 } }, /“stallTimeout” isn’t a field of hello\.settings/],
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
        [{ ...start, files: [{ name: 'attachments', text: '' }, ...start.files] }, /one of the turn folder’s own files/],
        [{ ...start, attachments: {} }, /start\.attachments must be a list/],
        [{ ...start, attachments: [{ name: '../x', base64: '' }] }, /start\.attachments\[0\]\.name must be a plain file name/],
        [{ ...start, attachments: [{ name: 'a.png', text: 'x' }] }, /“text” isn’t a field of start\.attachments\[0\]/],
        [{ ...start, attachments: [{ name: 'a.png', base64: 'AP9' }] }, /base64, padded with =/],
        [{ ...start, attachments: [{ name: 'a.png', base64: 'AP9-' }] }, /base64, padded with =/],
        [{ ...start, attachments: [{ name: 'a.png', base64: 'A=9B' }] }, /base64, padded with =/],
        [{ ...start, attachments: Array(2).fill({ name: 'a', base64: '' }) }, /names the file “a” twice/],
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
    // No argv: the daemon runs the signInCheck hello sent, so a check can’t name another program.
    check: { ok: {}, bad: [[{ argv: ['klist', '-s'] }, /“argv” isn’t a field of check/]] },
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
    'caught-up': {
      ok: { turn: 't1', log: 'in', size: 0 },
      bad: [
        [{ turn: 't1', log: 'err', size: 10 }, /caught-up\.log must be one of out, in/],
        [{ turn: 't1', log: 'out', size: -1 }, /caught-up\.size must be from 0/],
        [{ turn: 't1', log: 'out' }, /caught-up needs “size”/],
      ],
    },
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
        [{ turn: 't1', id: 'tool-1', name: 'permission_prompt', args: {} }, /isn’t a tool Postbox answers/],
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
    checked: {
      ok: { ok: false, code: null, at: 5 },
      bad: [
        [{ ok: true, code: 1, at: 5 }, /checked\.ok is true exactly when checked\.code is 0/],
        [{ ok: false, code: 0, at: 5 }, /checked\.ok is true exactly when checked\.code is 0/],
        [{ ok: false, code: 256, at: 5 }, /checked\.code must be from 0 to 255/],
        [{ ok: 'no', code: 1, at: 5 }, /checked\.ok must be true or false/],
        [{ ok: true, code: 0 }, /checked needs “at”/],
      ],
    },
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
    'permission-canceled': { ok: { id: 'p1', at: 1 }, bad: [[{ id: 'p1' }, /needs “at”/]] },
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
