import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAllowRule, rulesFor } from '../server/permission-rules.mjs';

test('a refused command is allowed once exactly, and always by its command (or exactly, if it chains)', () => {
  assert.deepEqual(rulesFor('Bash', { command: 'rm copy.txt' }), {
    once: 'Bash(rm copy.txt)',
    always: 'Bash(rm:*)',
    alwaysWords: 'commands that start with “rm”',
  });
  assert.equal(rulesFor('Bash', { command: 'npm test -- --watch' }).always, 'Bash(npm test:*)');
  assert.equal(rulesFor('Bash', { command: 'echo aGk= | base64 -d | bash' }).always, 'Bash(echo aGk= | base64 -d | bash)');
  assert.equal(rulesFor('Bash', { command: 'cat $(ls)' }).always, 'Bash(cat $(ls))');
});

test('fetches are allowed by domain, files by path, anything else by tool', () => {
  assert.equal(rulesFor('WebFetch', { url: 'https://example.com/a?b' }).always, 'WebFetch(domain:example.com)');
  assert.equal(rulesFor('Edit', { file_path: '/p/a.md' }).once, 'Edit(/p/a.md)');
  assert.equal(rulesFor('mcp__search__query', {}).always, 'mcp__search__query');
});

test('Always allow adds the rule to .claude/settings.local.json once, and keeps what else is there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-rules-'));
  await addAllowRule(dir, 'Bash(rm:*)');
  const file = join(dir, '.claude', 'settings.local.json');
  await writeFile(file, JSON.stringify({ env: { A: '1' }, permissions: { allow: ['Bash(rm:*)'], deny: ['Bash(sudo:*)'] } }));
  assert.equal((await addAllowRule(dir, 'Bash(rm:*)')).added, false);
  await addAllowRule(dir, 'WebFetch(domain:example.com)');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    env: { A: '1' },
    permissions: { allow: ['Bash(rm:*)', 'WebFetch(domain:example.com)'], deny: ['Bash(sudo:*)'] },
  });
  await writeFile(file, '{ not json');
  await assert.rejects(addAllowRule(dir, 'Edit'), /isn’t valid JSON/);
});
