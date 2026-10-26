import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addAllowRule, chains, rulesFor } from '../server/permission-rules.mjs';
import { splitCommand } from '../shared/command-chains.mjs';

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
    'cat <(ls)',
    'echo $((1|2))',
  ])
    assert.deepEqual(rulesFor('Bash', { command }), { once: null, always: null, alwaysWords: '', why: 'chained' }, command);
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
  for (const command of ['cat <<EOF\nhi\nEOF\nls', 'cat <<EOF | tee out.txt\nhi\nEOF', 'echo "it\'s" | grep i']) assert.equal(chains(command), true, command);
});

// A heredoc’s word as the shell reads it (POSIX, “Here-Document”; bash’s manual, “Here Documents”): quote removal
// applies to the word, and the body ends at the line that is that word, with leading tabs stripped for <<-. Quoting any
// of it means the body isn’t expanded; otherwise a $( ) or ` ` in the body runs, so it’s a part (as in a command).
test('a heredoc whose word is quoted, escaped or has punctuation in it is one command, as the shell reads it', () => {
  for (const command of [
    'cat > a.json <<\'END-JSON\'\n{ "a": 1 };\nEND-JSON',
    'cat <<"END.X"\na && b\nEND.X\n',
    'cat <<\\EOF\n$(not run) | x\nEOF',
    'cat <<E"O"F\na; b\nEOF',
    'cat <<END-JSON\n{ "a": 1 } | x\nEND-JSON',
    "cat <<-'EOF'\n\tone; two\n\t\tEOF",
    "cat <<A <<'B'\na; b\nA\nc | d\nB",
    // Only an exact line ends the body: " EOF" doesn’t, nor does a tab-indented one without <<-, so ls is the body’s.
    'cat <<EOF\nhi\n EOF\nls\nEOF',
    'cat <<EOF\nhi\n\tEOF\nls\nEOF',
    // Unterminated: bash reads the body to the end (with a warning), so nothing after it is another command.
    "cat <<'EOF'\na && b\nEND",
    'echo $((1 << 2)) > out.txt',
  ])
    assert.equal(chains(command), false, command);
  for (const command of [
    "cat <<'END-JSON' > a.json\n{}\nEND-JSON\nnpm test && echo ok",
    "cat <<'EOF' && ls\nhi\nEOF",
    // The command after the terminator line is another one, whatever the word holds.
    'cat <<END-JSON\n{}\nEND-JSON\nls',
    'cat <<E"O"F\nx\nEOF\nls',
    'cat <<-EOF\n\tx\n\tEOF\nls',
    // A << in $(( )) is a shift, not a heredoc that would hide the next line.
    'echo $((1 << 2))\nls',
  ])
    assert.equal(chains(command), true, command);
  assert.equal(chains('cat <<EOF\n\\$(not run)\nEOF'), false, 'an escaped $ in an expanded body');
  // An unquoted word’s body is expanded, so a substitution in it runs: a part (below), though it doesn’t chain (#309).
  for (const command of ['cat <<EOF\n$(date)\nEOF', 'cat <<END-X\n`date`\nEND-X']) {
    assert.equal(chains(command), false, command);
    assert.ok(splitCommand(command).includes('date'), command);
  }
  assert.equal(rulesFor('Bash', { command: "cat > a.json <<'END-JSON'\n{}\nEND-JSON" }).once, "Bash(cat > a.json <<'END-JSON'\n{}\nEND-JSON)");
});

// The shell removes a backslash-newline before it reads words, except in single quotes and in a body whose word is
// quoted (POSIX, “Escape Character”, “Here-Document”), and its quote removal applies to a heredoc’s word: in "",
// a backslash escapes only $ ` " \ and newline; in '', none. Each command ran as /bin/bash -c (bash 3.2.57) in an
// empty folder; true where the echo printed RAN, so the shell ran a second command. 'sub' where it ran inside a
// command substitution, which since #309 doesn’t chain the command but is still one of its parts.
test('a backslash-newline or an escaped quote in or around a heredoc reads as the shell reads it', () => {
  const C = 'cat >/dev/null';
  const M = 'echo R""AN >&2';
  for (const [command, ran] of [
    [`${C} <<EO\\\nF\na; b\nEOF\n${M}`, true],
    [`${C} <<EO\\\nF\na; b\nEOF`, false],
    [`${C} <<EO\\\nF\n$(${M})\nEOF`, 'sub'], // the word has no quotes, so the body is expanded
    [`${C} <<\\\nEOF\na; b\nEOF\n${M}`, true],
    [`${C} <<\\\n-EOF\n\ta; b\n\tEOF\n${M}`, true],
    [`${C} <\\\n<EOF\na; b\nEOF`, false],
    [`${C} <\\\n<\\\n< "a;b"`, false],
    [`${C} <<EOF \\\n&& ${M}\nhi\nEOF`, true],
    [`${C} <<EO\\\nF && ${M}\nhi\nEOF`, true],
    [`${C} <<EO\\\nF; ${M}\nhi\nEOF`, true],
    [`${C} <<E\\"OF\na; b\nE"OF`, false],
    [`${C} <<"E\\"OF"\na; b\nE"OF`, false],
    [`${C} <<"E\\"OF"\na; b\nE"OF\n${M}`, true],
    [`${C} <<"E\\"OF" && ${M}\na; b\nE"OF`, true],
    [`${C} <<'E\\'\na; b\nE\\`, false],
    [`${C} <<'E\\'\na; b\nE\\\n${M}`, true],
    [`${C} <<"E\\aF"\na; b\nE\\aF\n${M}`, true],
    [`${C} <<"E\\\nF"\na; b\nEF\n${M}`, true],
    [`${C} <<'E\\\nF'\na; b\nE\\\nF\n${M}`, false],
    [`${C} <<A <<B\\\nC\nx\nA\ny\nBC\n${M}`, true],
    // In an expanded body a backslash-newline joins lines, so EO\⏎F ends it and hi\⏎EOF doesn’t; \\ is a backslash.
    [`${C} <<EOF\na; b\nEO\\\nF\n${M}`, true],
    [`${C} <<-EOF\n\ta\n\tEO\\\nF\n${M}`, true],
    [`${C} <<EOF\nhi\\\nEOF\n${M}`, false],
    [`${C} <<EOF\nhi\\\\\nEOF\n${M}`, true],
    [`${C} <<EOF\nhi\nEOF\\\n${M}\nEOF`, false],
    [`${C} <<EOF\n$\\\n(${M})\nEOF`, 'sub'],
    [`${C} <<'EOF'\na; b\nEO\\\nF\nEOF\n${M}`, true],
    [`${C} <<'EOF'\nhi\\\nEOF\n${M}`, true],
    [`${C} <<'EOF'\n$\\\n(${M})\nEOF`, false],
    // And outside heredocs: an operator or $( that a backslash-newline splits is still one.
    [`echo $\\\n(${M})`, 'sub'],
    ['echo $(\\\n(1+2))', false],
    ['echo hi >\\\n| /dev/null', false],
    ['echo hi 2>\\\n&1', false],
    ['echo hi &\\\n>/dev/null', false],
  ])
    if (ran === 'sub') {
      assert.equal(chains(command), false, command);
      assert.ok(splitCommand(command).includes(M), command);
    } else assert.equal(chains(command), ran, command);
});

// #281: Claude Code reads * in a Bash rule as a wildcard, so a rule with the command’s own text allows more than it: with
// only Bash(touch D/a*) allowed, a real Claude Code 2.1.310 ran `touch D/a2 D/zz` (claude-ssh-aarch64’s check on #281).
test('#281 a command with a * gets no rule at all, since its own text would be a wildcard rule', () => {
  for (const command of ['rm -rf build/*', 'ls *.md', 'git add "src/*.mjs"', 'grep -r x .:*'])
    assert.deepEqual(rulesFor('Bash', { command }), { once: null, always: null, alwaysWords: '', why: 'wildcard' }, command);
});

// #281: Claude Code doesn’t strip env or bash -c, so Bash(env:*) and Bash(bash:*) let anything run after them (checked
// with real Claude Code on #281). A wrapper only ever gets its exact text.
test('#281 a program that runs the command after it gets only its exact text, never Bash(env:*) or Bash(bash:*)', () => {
  for (const command of ["bash -c 'ls'", 'env X=1 ls', 'sudo ls', '/usr/bin/env ls', 'nohup make', 'xargs rm', 'time make', 'nice make'])
    assert.deepEqual(rulesFor('Bash', { command }), { once: `Bash(${command})`, always: `Bash(${command})`, alwaysWords: `exactly “${command}”` }, command);
  assert.equal(rulesFor('Bash', { command: 'make test' }).always, 'Bash(make test:*)', 'other programs keep their broader rule');
  // So do programs that run code given as an argument, and a flag as the second word (`node -e`, `git -c`), which
  // would otherwise make Bash(node -e:*): as wide as Bash(bash:*) (claude-ssh-aarch64’s review of this change).
  for (const command of [
    "node -e 'x'",
    "python3 -c 'x'",
    'python -m pytest -q',
    'git -c core.pager=sh log',
    "perl -e 'x'",
    "ruby -e 'x'",
    'awk 1 f',
    'ssh host ls',
    'npx -y pkg',
    '/usr/bin/node -e x',
    'python3.12 -c x',
    'pypy3 -c x',
    'python3',
  ])
    assert.equal(rulesFor('Bash', { command }).always, `Bash(${command})`, command);
  for (const [command, always] of [
    ['git status', 'Bash(git status:*)'],
    ['npm test', 'Bash(npm test:*)'],
    ['python script.py --x', 'Bash(python script.py:*)'],
    ['python3 tools/a.py', 'Bash(python3 tools/a.py:*)'],
    ['node app/x.js', 'Bash(node app/x.js:*)'],
  ])
    assert.equal(rulesFor('Bash', { command }).always, always, command);
});

// #309: what real Claude Code 2.1.310 turns (claude -p, default mode) ran on the exact command’s allow rule, and what
// they refused on it, in a temp folder with each command’s effect checked on disk; bash reads each as written.
test(`#309 a substitution, \${ } or [[ ]] doesn’t chain, so it gets Allow once; <( ) and $(( )) still chain`, () => {
  for (const command of [
    'touch "$(echo f)"',
    'touch "`echo f`"',
    'cat > out <<EOF\n$(echo x)\nEOF',
    'git commit -m "$(cat <<\'EOF\'\nFix it; and && more\nEOF\n)"',
    `echo \${UNSET:-a;b} > out`,
    '[[ -d a && -d b ]]',
  ]) {
    assert.equal(chains(command), false, command);
    assert.equal(rulesFor('Bash', { command }).once, `Bash(${command})`, command);
  }
  // Refused on their exact rules, so still no Allow once: a process substitution and $(( )). And a separator inside a
  // substitution, or after [[ ]], is still a chain.
  for (const command of ['cat <(echo hi) > out', 'echo $((1|2)) > out', 'touch "$(a; b)"', '[[ -d a ]] && rm x', 'x=[[ ; y'])
    assert.equal(chains(command), true, command);
  // The write guard still reads the commands inside each, as deny and ask rules do.
  assert.deepEqual(splitCommand('touch "$(rm -rf x)"'), ['rm -rf x', 'touch "$(rm -rf x)"']);
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
