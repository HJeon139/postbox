// The environment and the output of a confirmed gh command (#852): what the child may see of Postbox’s environment,
// and what of its output reaches the conversation. Running it is in tests/process/confirm-run.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanOutput, ghEnv } from '../server/confirm-run.mjs';

const FIXED = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GH_EDITOR: 'false',
  EDITOR: 'false',
  VISUAL: 'false',
  BROWSER: 'false',
};

test('#852 ghEnv keeps only PATH, HOME and the gh tokens and config folder, plus the fixed no-prompt settings', () => {
  const env = {
    POSTBOX_X: 'secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GIT_DIR: '/elsewhere/.git',
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    GH_TOKEN: 'gho_abc',
    GITHUB_TOKEN: 'ghp_def',
    GH_CONFIG_DIR: '/home/someone/.config/gh',
    EDITOR: 'vim',
  };
  assert.deepEqual(ghEnv(env), {
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    GH_TOKEN: 'gho_abc',
    GITHUB_TOKEN: 'ghp_def',
    GH_CONFIG_DIR: '/home/someone/.config/gh',
    ...FIXED,
  });
});

test('#852 ghEnv leaves out an allowed key that isn’t set, rather than passing it empty', () => {
  assert.deepEqual(ghEnv({ PATH: '/bin', HOME: undefined, POSTBOX_GH_BIN: '/x/gh' }), { PATH: '/bin', ...FIXED });
});

test('#852 cleanOutput removes CSI color codes', () => {
  assert.equal(cleanOutput('\x1b[1;31mred\x1b[0m and \x1b[2Kplain'), 'red and plain');
});

test('#852 cleanOutput removes OSC sequences ended by BEL or by ESC backslash', () => {
  assert.equal(cleanOutput('a\x1b]0;title\x07b\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\c'), 'ablinkc');
});

test('#852 cleanOutput removes carriage returns, bells and other control characters, and keeps tabs and newlines', () => {
  assert.equal(cleanOutput('one\r\ntwo\x07\tthree\x00\x08\x9b\nfour'), 'one\ntwo\tthree\nfour');
});

test('#852 cleanOutput cuts past 4,000 characters and marks the cut with an ellipsis', () => {
  const cut = cleanOutput('x'.repeat(5000));
  assert.equal(cut, `${'x'.repeat(4000)}…`);
  assert.equal(cleanOutput('y'.repeat(4000)), 'y'.repeat(4000));
});

test('#852 cleanOutput cuts after stripping, so color codes don’t use up the 4,000', () => {
  const colored = '\x1b[32mz\x1b[0m'.repeat(4000);
  assert.equal(cleanOutput(colored), 'z'.repeat(4000));
});
