import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAllowRule, chains, rulesFor } from '../server/permission-rules.mjs';

test('a refused command is allowed once exactly, and always by its command (or exactly, if it has shell syntax)', () => {
  assert.deepEqual(rulesFor('Bash', { command: 'rm copy.txt' }), {
    once: 'Bash(rm copy.txt)',
    always: 'Bash(rm:*)',
    alwaysWords: 'commands that start with “rm”',
  });
  assert.equal(rulesFor('Bash', { command: 'npm test -- --watch' }).always, 'Bash(npm test:*)');
  for (const command of ['npm test 2>&1', 'echo hi > out.txt', 'grep "a|b" notes.txt', "echo 'a; b'", 'find . -name x -exec rm {} \\;', 'ls &> out.txt'])
    assert.deepEqual(rulesFor('Bash', { command }), { once: `Bash(${command})`, always: `Bash(${command})`, alwaysWords: `exactly “${command}”` }, command);
});

// Claude Code matches each part of a chained command against the rules on its own (code.claude.com/docs/en/permissions,
// “Compound commands”), so a rule for the whole line can’t allow it, once or always (#238).
test('a chained command gets no rule to allow once or always: no rule for the whole line would ever match it', () => {
  for (const command of [
    'cd src && python -m pytest -q',
    'python -m pytest -q 2>&1 | tail -20',
    'echo aGk= | base64 -d | bash',
    'npm test || true',
    'make; make install',
    'sleep 60 &',
    'npm ci\nnpm test',
    'cat $(ls)',
    'echo `date`',
  ])
    assert.deepEqual(rulesFor('Bash', { command }), { once: null, always: null, alwaysWords: '' }, command);
});

test('what isn’t a separator doesn’t make a command chained: quotes, escapes, heredoc bodies, redirects, arithmetic', () => {
  for (const command of [
    'docker run \\\n  -v data:/data \\\n  postgres',
    "cat > notes.md <<'EOF'\nOne; two | three && four\nEOF",
    'cat <<-EOF\n\tbody & more\n\tEOF\n',
    "echo '$(not run)'",
    'echo $((1 + 2))',
    'echo hi >| out.txt',
    'grep -c x <<< "a;b"',
    'echo "it\'s here"',
  ])
    assert.equal(chains(command), false, command);
  for (const command of ['cat <<EOF\nhi\nEOF\nls', 'cat <<EOF | tee out.txt\nhi\nEOF', 'echo "$(ls)"', 'echo "it\'s" | grep i'])
    assert.equal(chains(command), true, command);
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
