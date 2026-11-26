import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10_000 });

test('the command prints a title’s slug', () => {
  assert.equal(run('slug', 'Hello, World').stdout, 'hello-world\n');
});

test('the command prints a title in title case, and its file name', () => {
  assert.equal(run('title', 'the tale of a cat').stdout, 'The Tale of a Cat\n');
  assert.equal(run('filename', 'Hello, World', 'md').stdout, 'hello-world.md\n');
});

test('the command says how to use it, and exits 1, for a form it doesn’t know', () => {
  const r = run('shout', 'Hello');
  assert.equal(r.status, 1);
  for (const form of ['slug', 'title', 'filename']) assert.ok(r.stderr.includes(form), `the usage names ${form}`);
});
