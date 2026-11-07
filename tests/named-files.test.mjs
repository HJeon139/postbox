// Every file a command names (server/named-files.mjs, #852): a confirmed command keeps the hash of each file it
// reads, so an edit after the person confirmed it makes it ask again. Each form a command names a file by is read;
// one the reader can’t be sure of refuses, rather than leave a file out.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashFiles, namedFiles, sameFiles } from '../server/named-files.mjs';
import { tempDir } from './temp-dirs.mjs';

function folder() {
  const dir = realpathSync(tempDir('pb-named-files-'));
  mkdirSync(join(dir, 'sub'));
  for (const name of ['a.sh', 'b.md', 'in.txt', 'f.json', 'my file.sh', 'sub/c.py']) writeFileSync(join(dir, name), `${name}\n`);
  return dir;
}

const FORMS = [
  ['bash’s script', 'bash a.sh', 'a.sh'],
  ['sh’s script after a flag', 'sh -e a.sh', 'a.sh'],
  ['zsh’s script', 'zsh a.sh', 'a.sh'],
  ['node’s script', 'node a.sh', 'a.sh'],
  ['python’s script', 'python sub/c.py', 'sub/c.py'],
  ['python3’s script', 'python3 -u sub/c.py', 'sub/c.py'],
  ['source’s file', 'source a.sh', 'a.sh'],
  ['.’s file', '. a.sh', 'a.sh'],
  ['a ./ path as the command', './a.sh --flag', 'a.sh'],
  ['a ../ path as the command', '../x/a.sh', 'a.sh', 'sub'],
  ['an absolute path as the command', '<abs>/a.sh', 'a.sh'],
  ['--body-file f', 'gh pr create --body-file b.md', 'b.md'],
  ['--body-file=f', 'gh pr create --body-file=b.md', 'b.md'],
  ['--input f', 'gh api repos/x --input f.json', 'f.json'],
  ['--input=f', 'gh api repos/x --input=f.json', 'f.json'],
  ['-F k=@f', 'gh api x -F body=@b.md', 'b.md'],
  ['-Fk=@f', 'gh api x -Fbody=@b.md', 'b.md'],
  ['-f k=@f', 'gh api x -f body=@b.md', 'b.md'],
  ['--field k=@f', 'gh api x --field body=@b.md', 'b.md'],
  ['a < redirect', 'cat < in.txt', 'in.txt'],
  ['a <redirect with no space', 'wc -l <in.txt', 'in.txt'],
];

for (const [name, template, file, cwd] of FORMS) {
  test(`namedFiles finds ${name}`, () => {
    const dir = folder();
    let command = template.replace('<abs>', dir);
    let where = dir;
    if (cwd) {
      // ../x/a.sh from sub, where x is a link to the folder itself.
      symlinkSync(dir, join(dir, 'x'));
      where = join(dir, cwd);
      command = template;
    }
    assert.deepEqual(namedFiles(command, where), { ok: true, files: [join(dir, file)] });
  });
}

test('namedFiles finds no file in a command that names none', () => {
  assert.deepEqual(namedFiles('git status && ls -la', folder()), { ok: true, files: [] });
});

test('namedFiles never takes --raw-field’s value as a file', () => {
  assert.deepEqual(namedFiles('gh api x --raw-field body=@b.md', folder()), { ok: true, files: [] });
});

test('namedFiles takes no file from a -F value without =@', () => {
  assert.deepEqual(namedFiles('gh api x -F title=hello', folder()), { ok: true, files: [] });
});

test('namedFiles reads quoted paths', () => {
  const dir = folder();
  assert.deepEqual(namedFiles('bash "my file.sh" && cat < \'my file.sh\'', dir), { ok: true, files: [join(dir, 'my file.sh')] });
});

test('namedFiles resolves .. in a path', () => {
  const dir = folder();
  assert.deepEqual(namedFiles('bash sub/../a.sh', dir), { ok: true, files: [join(dir, 'a.sh')] });
});

test('namedFiles follows a symlink to the file it names', () => {
  const dir = folder();
  symlinkSync(join(dir, 'a.sh'), join(dir, 'link.sh'));
  assert.deepEqual(namedFiles('bash link.sh', dir), { ok: true, files: [join(dir, 'a.sh')] });
});

test('namedFiles skips VAR=x before the command word', () => {
  const dir = folder();
  assert.deepEqual(namedFiles('A=1 B=two node a.sh', dir), { ok: true, files: [join(dir, 'a.sh')] });
});

test('namedFiles finds the files of every part of a chain, once each', () => {
  const dir = folder();
  const got = namedFiles('bash a.sh && gh pr create --body-file b.md; bash a.sh', dir);
  assert.deepEqual(got, { ok: true, files: [join(dir, 'a.sh'), join(dir, 'b.md')] });
});

test('namedFiles resolves an absolute path with no folder', () => {
  const dir = folder();
  assert.deepEqual(namedFiles(`bash ${dir}/a.sh`, null), { ok: true, files: [join(dir, 'a.sh')] });
});

test('namedFiles refuses a relative path with no folder', () => {
  const got = namedFiles('bash a.sh', null);
  assert.equal(got.ok, false);
});

test('namedFiles refuses a file it can’t find', () => {
  const got = namedFiles('bash missing.sh', folder());
  assert.equal(got.ok, false);
});

for (const command of ['gh pr create --body-file -', 'gh api x --input=-', 'gh api x -F body=@-', 'bash -']) {
  test(`namedFiles refuses stdin as a file: ${command}`, () => {
    assert.equal(namedFiles(command, folder()).ok, false);
  });
}

const UNREADABLE = [
  'gh pr create --body-file "$F"',
  'gh api x --input $(echo f.json)',
  'gh api x -F body=@`echo b.md`',
  'cat < $F',
  'bash $SCRIPT',
  'X=1 python3 $(echo a.sh)',
  'cat <<EOF\nhi\nEOF',
  './$NAME',
];
for (const command of UNREADABLE) {
  test(`namedFiles refuses a part it can’t read that may name a file: ${JSON.stringify(command)}`, () => {
    assert.equal(namedFiles(command, folder()).ok, false);
  });
}

test('namedFiles passes $(…) guard parts that name no file', () => {
  const dir = folder();
  const command = 'test "$(git rev-parse --abbrev-ref HEAD)" = main && echo $(date) && gh pr create --body-file b.md';
  assert.deepEqual(namedFiles(command, dir), { ok: true, files: [join(dir, 'b.md')] });
});

test('hashFiles gives each file’s sha256', async () => {
  const dir = folder();
  const got = await hashFiles([join(dir, 'a.sh')]);
  const sha256 = createHash('sha256').update('a.sh\n').digest('hex');
  assert.deepEqual(got, { ok: true, files: [{ path: join(dir, 'a.sh'), sha256 }] });
});

test('hashFiles refuses a file it can’t read', async () => {
  const dir = folder();
  const got = await hashFiles([join(dir, 'a.sh'), join(dir, 'gone.sh')]);
  assert.equal(got.ok, false);
});

test('hashFiles hashes the file a symlink points at, by its real path', async () => {
  const dir = folder();
  symlinkSync(join(dir, 'a.sh'), join(dir, 'link.sh'));
  const got = await hashFiles([join(dir, 'link.sh')]);
  const direct = await hashFiles([join(dir, 'a.sh')]);
  assert.deepEqual(got, direct);
});

test('sameFiles holds while no file changes', async () => {
  const dir = folder();
  const got = await hashFiles([join(dir, 'a.sh'), join(dir, 'b.md')]);
  assert.equal(got.ok && (await sameFiles(got.files)), true);
});

test('sameFiles fails once a file is edited after hashing', async () => {
  const dir = folder();
  const got = await hashFiles([join(dir, 'a.sh'), join(dir, 'b.md')]);
  writeFileSync(join(dir, 'b.md'), 'changed\n');
  assert.equal(got.ok && (await sameFiles(got.files)), false);
});

test('sameFiles fails once a file is gone', async () => {
  const dir = folder();
  const got = await hashFiles([join(dir, 'a.sh')]);
  rmSync(join(dir, 'a.sh'));
  assert.equal(got.ok && (await sameFiles(got.files)), false);
});

test('sameFiles fails once the file a symlink points at is edited', async () => {
  const dir = folder();
  symlinkSync(join(dir, 'a.sh'), join(dir, 'link.sh'));
  const named = namedFiles('bash link.sh', dir);
  const got = await hashFiles(named.ok ? named.files : []);
  assert.equal(got.ok, true);
  writeFileSync(join(dir, 'a.sh'), 'echo pwned\n');
  assert.equal(got.ok && (await sameFiles(got.files)), false);
});
