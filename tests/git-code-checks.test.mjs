// Whether a repository runs its own code (server/git-code-checks.mjs, #852): a hook, a config key that names a
// program, or an attribute that sends a file through a filter or driver makes git run code the repository holds, so
// a command that runs git there isn’t one the person can read in full. The checks read files and never run git.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configKeys, RUNS_CODE, repoRunsCode } from '../server/git-code-checks.mjs';
import { tempDir } from './temp-dirs.mjs';

const PLAIN_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
[remote "origin"]
\turl = https://github.com/x/y.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
`;

/** A repository with a .git folder and a plain config; `extra` is appended to the config. */
function repo(extra = '') {
  const dir = tempDir('pb-git-checks-');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(dir, '.git', 'info'));
  writeFileSync(join(dir, '.git', 'config'), PLAIN_CONFIG + extra);
  return dir;
}

test('a plain repository runs no code of its own', async () => {
  assert.deepEqual(await repoRunsCode(repo()), { ok: true });
});

test('a folder inside a plain repository runs no code of its own', async () => {
  const dir = repo();
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  assert.deepEqual(await repoRunsCode(join(dir, 'src', 'deep')), { ok: true });
});

test('a folder inside a repository is checked against its root’s config', async () => {
  const dir = repo('[core]\n\tfsmonitor = ./watch.sh\n');
  mkdirSync(join(dir, 'src'));
  assert.equal((await repoRunsCode(join(dir, 'src'))).ok, false);
});

test('a folder in no repository fails', async () => {
  // The temp folder itself has no .git above it unless the system’s temp folder sits in one.
  const dir = tempDir('pb-git-none-');
  assert.equal((await repoRunsCode(dir)).ok, false);
});

test('a .git file with gitdir: fails', async () => {
  const dir = tempDir('pb-git-gitdir-');
  writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/else/.git/worktrees/x\n');
  assert.equal((await repoRunsCode(dir)).ok, false);
});

test('a .sample hook passes, executable or not', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
  chmodSync(join(dir, '.git', 'hooks', 'pre-commit.sample'), 0o755);
  assert.deepEqual(await repoRunsCode(dir), { ok: true });
});

test('a hook that isn’t executable passes', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
  chmodSync(join(dir, '.git', 'hooks', 'pre-push'), 0o644);
  assert.deepEqual(await repoRunsCode(dir), { ok: true });
});

test('an executable hook fails, by name', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n');
  chmodSync(join(dir, '.git', 'hooks', 'pre-push'), 0o755);
  const got = await repoRunsCode(dir);
  assert.equal(got.ok, false);
  assert.match(got.ok ? '' : got.why, /pre-push/);
});

// One config line per pattern in RUNS_CODE, each a key that pattern names.
const KEYS = [
  ['a name ending .command', '[diff "x"]\n\tcommand = ./d.sh'],
  ['a name ending program', '[sendemail]\n\tsmtpProgram = ./mail.sh'],
  ['a name ending helper', '[remote "origin"]\n\tvcsHelper = ./h.sh'],
  ['a name ending cmd', '[mergetool "x"]\n\tcmd = ./m.sh'],
  ['pager.*', '[pager]\n\tlog = ./p.sh'],
  ['a name ending uploadpack', '[remote "origin"]\n\tuploadpack = ./u.sh'],
  ['a name ending receivepack', '[remote "origin"]\n\treceivepack = ./r.sh'],
  ['core.fsmonitor', '[core]\n\tfsmonitor = ./watch.sh'],
  ['core.editor', '[core]\n\teditor = ./e.sh'],
  ['core.pager', '[core]\n\tpager = ./p.sh'],
  ['core.hooksPath', '[core]\n\thooksPath = tools/hooks'],
  ['core.sshCommand', '[core]\n\tsshCommand = ./ssh.sh'],
  ['core.askPass', '[core]\n\taskPass = ./ask.sh'],
  ['diff.external', '[diff]\n\texternal = ./d.sh'],
  ['sequence.editor', '[sequence]\n\teditor = ./e.sh'],
  ['include.path', '[include]\n\tpath = ../evil.config'],
  ['includeIf.*.path', '[includeIf "gitdir:/x/"]\n\tpath = ../evil.config'],
  ['url.*.insteadOf', '[url "file:///tmp/evil"]\n\tinsteadOf = https://github.com/'],
  ['url.*.pushInsteadOf', '[url "file:///tmp/evil"]\n\tpushInsteadOf = https://github.com/'],
  ['alias.*', '[alias]\n\tst = !./s.sh'],
  ['filter.*', '[filter "lfs"]\n\tsmudge = ./s.sh'],
  ['merge.*.driver', '[merge "x"]\n\tdriver = ./m.sh %O %A %B'],
  ['diff.*.textconv', '[diff "x"]\n\ttextconv = ./t.sh'],
  ['gpg.program', '[gpg]\n\tprogram = ./g.sh'],
  ['gpg.ssh.program', '[gpg "ssh"]\n\tprogram = ./g.sh'],
  ['credential.*', '[credential]\n\tuseHttpPath = true'],
  ['a key in upper case', '[CORE]\n\tFSMONITOR = ./watch.sh'],
  ['a legacy [section.sub] header', '[url.evil]\n\tinsteadOf = https://github.com/'],
  ['a key on its header’s line', '[core] fsmonitor = ./watch.sh'],
  ['a key with no value', '[alias]\n\tst'],
];

for (const [name, text] of KEYS) {
  test(`config with ${name} fails, by its key`, async () => {
    const got = await repoRunsCode(repo(`${text}\n`));
    assert.equal(got.ok, false);
    const key = text.split('\n').at(-1).replace(/^.*\]/, '').trim().split(/\s*=/)[0];
    assert.match(got.ok ? '' : got.why.toLowerCase(), new RegExp(key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('the table above holds a key for every RUNS_CODE pattern', () => {
  const keys = KEYS.flatMap(([, text]) => configKeys(text));
  for (const pattern of RUNS_CODE)
    assert.ok(
      keys.some((key) => pattern.test.test(key)),
      pattern.name,
    );
});

test('config keys that run nothing pass', async () => {
  const text = '[user]\n\tname = A\n\temail = a@b.c\n[pull]\n\trebase = true\n[core]\n\tautocrlf = input\n\tcommandLine = no\n';
  assert.deepEqual(await repoRunsCode(repo(text)), { ok: true });
});

test('a comment or a quoted value that names a key passes', async () => {
  const text = '# core.fsmonitor = ./watch.sh\n; [alias]\n[user]\n\tname = "core.editor = x"\n';
  assert.deepEqual(await repoRunsCode(repo(text)), { ok: true });
});

test('a value continued onto the next line fails, as git and this reader could split it apart', async () => {
  const text = '[user]\n\tname = a \\\n[core]\n\tfsmonitor = ./watch.sh\n';
  assert.equal((await repoRunsCode(repo(text))).ok, false);
});

test('a config line it can’t parse fails', async () => {
  assert.equal((await repoRunsCode(repo('[core\n\tfsmonitor = ./w.sh\n'))).ok, false);
});

const ATTRIBUTES = [
  ['filter=', '*.bin filter=lfs'],
  ['diff=', '*.png diff=exif'],
  ['merge=', '*.lock merge=ours'],
  ['a macro that sets filter=', '[attr]tricky filter=x'],
];
for (const where of ['.gitattributes', '.git/info/attributes']) {
  for (const [name, line] of ATTRIBUTES) {
    test(`${where} with ${name} fails`, async () => {
      const dir = repo();
      writeFileSync(join(dir, where), `*.txt text\n${line}\n`);
      const got = await repoRunsCode(dir);
      assert.equal(got.ok, false);
      assert.match(got.ok ? '' : got.why, new RegExp(where.replace('.', '\\.')));
    });
  }
  test(`${where} that unsets diff and merge passes`, async () => {
    const dir = repo();
    writeFileSync(join(dir, where), '# filter=x in a comment\n*.bin -diff -merge -text binary\n*.md diff !merge\n');
    assert.deepEqual(await repoRunsCode(dir), { ok: true });
  });
}
