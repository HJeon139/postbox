// The environment and the output of a confirmed gh command (#852): what the child may see of Postbox’s environment,
// and what of its output reaches the conversation. Running it is in tests/process/confirm-run.test.mjs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanOutput, ghConfigProblem, ghEnv } from '../server/confirm-run.mjs';
import { tempDir } from './temp-dirs.mjs';

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

const GIT = {
  GIT_DIR: '/tmp/pb-confirm-gh-x/no-repository',
  GIT_CEILING_DIRECTORIES: '/tmp',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
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
  assert.deepEqual(ghEnv(env, '/tmp/pb-confirm-gh-x'), {
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    GH_TOKEN: 'gho_abc',
    GITHUB_TOKEN: 'ghp_def',
    GH_CONFIG_DIR: '/home/someone/.config/gh',
    ...GIT,
    ...FIXED,
  });
});

test('#852 ghEnv leaves out an allowed key that isn’t set, rather than passing it empty', () => {
  const env = ghEnv({ PATH: '/bin', HOME: '/h', XDG_CONFIG_HOME: '/h/xdg', POSTBOX_GH_BIN: '/x/gh' }, '/tmp/pb-confirm-gh-x');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GH_CONFIG_DIR: '/h/xdg/gh', ...GIT, ...FIXED }, 'the config folder as gh finds it, XDG included');
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

test('#852 r3: gh’s config that could send the call elsewhere refuses it: a socket, another host, an alias for pr or issue', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const cases = [
    ['config.yml', 'git_protocol: https\nhttp_unix_socket: /tmp/agent.sock\n', /socket/],
    ['config.yml', 'aliases:\n    pr: "!curl x"\n', /alias named pr or issue/],
    ['config.yml', 'aliases:\n  issue: api x\n', /alias named pr or issue/],
    ['hosts.yml', 'github.com:\n    user: me\nghe.example.com:\n    user: me\n', /ghe\.example\.com/],
  ];
  for (const [file, text, why] of cases) {
    const dir = tempDir('pb-ghconf-');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), text);
    assert.match((await ghConfigProblem(dir)) ?? '', why, text);
  }
  const plain = tempDir('pb-ghconf-');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'config.yml'), 'git_protocol: https\nhttp_unix_socket:\naliases:\n    co: pr checkout\n');
  await writeFile(join(plain, 'hosts.yml'), 'github.com:\n    user: me\n    git_protocol: https\n');
  assert.equal(await ghConfigProblem(plain), null);
  assert.equal(await ghConfigProblem(join(plain, 'none')), null, 'no config at all');
});

test('#852 r3: gh’s config is refused in every YAML form gh reads: quoted keys and flow style too', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const cases = [
    ['config.yml', '"http_unix_socket": /tmp/agent.sock\n', /socket/],
    ['config.yml', "'http_unix_socket': '/tmp/agent.sock'\n", /socket/],
    ['config.yml', '{git_protocol: https, http_unix_socket: /tmp/agent.sock}\n', /socket/],
    ['config.yml', 'aliases: {pr: "!curl x"}\n', /alias named pr or issue/],
    ['config.yml', 'aliases:\n    "issue": api x\n', /alias named pr or issue/],
    ['hosts.yml', '{github.com: {user: me}, ghe.example.com: {user: me}}\n', /ghe\.example\.com/],
    ['hosts.yml', '"ghe.example.com":\n    user: me\n', /ghe\.example\.com/],
  ];
  for (const [file, text, why] of cases) {
    const dir = tempDir('pb-ghconf-');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), text);
    assert.match((await ghConfigProblem(dir)) ?? '', why, text);
  }
});

test('#852 r3: cleanOutput removes bidi and other format characters, which can reorder or hide text', () => {
  assert.equal(cleanOutput('safe \u202eevil\u202c and \u200bhidden\u2066x\u2069'), 'safe evil and hiddenx');
});
