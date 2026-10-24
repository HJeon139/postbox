// The write guard (#112) and the panel’s effective view split a command into the parts the shell runs, with the
// scanner chains uses (shared/command-chains.mjs): a heredoc’s body is data, a command substitution runs, and a quote
// in a comment or a quoted body opens nothing. Before, an apostrophe in a quoted body hid every command after it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WRITE_TOOLS } from '../server/adapters/setup.mjs';
import { chains } from '../server/permission-rules.mjs';
import { isWriteCall } from '../server/write-guard.mjs';
import { decide, splitCommand } from '../shared/permission-match.mjs';

const W = 'gh pr create --title x';
// Each command ran under /bin/bash -c (bash 3.2.57) in an empty folder with W as `echo R""AN >&2`; true where it
// printed RAN, so the shell ran W.
const ROWS = [
  [`cat > notes.md <<'EOF'\ndon't\nEOF\n${W}`, true],
  [`cat > notes.md <<'EOF'\n${W}\nEOF`, false],
  [`cat > notes.md <<EOF\n${W}\nEOF`, false],
  [`cat <<EOF\n$(${W})\nEOF`, true],
  [`cat <<EOF\n\\$(${W})\nEOF`, false],
  [`cat <<'EOF'\n$(${W})\nEOF`, false],
  [`bash <<'EOF'\n${W}\nEOF`, true], // a shell runs its body
  [`cat <<'EOF' | bash\n${W}\nEOF`, true],
  [`source /dev/stdin <<'EOF'\n${W}\nEOF`, true],
  [`bash -c "$(cat <<'EOF'\n${W}\nEOF\n)"`, true],
  [`cat <<$'EOF'\nx\nEOF\n${W}`, true],
  [`cat <<"EOF"\ndon't\nEOF\n${W}`, true],
  [`cat <<\\EOF\ndon't\nEOF\n${W}`, true],
  [`cat <<-'EOF'\n\tdon't\n\tEOF\n${W}`, true],
  [`cat <<'EOF' && ${W}\ndon't\nEOF`, true],
  [`sleep 0 & ${W}`, true],
  [`echo $(${W})`, true],
  [`echo "$(${W})"`, true],
  [`echo \`${W}\``, true],
  [`cat <(${W})`, true],
  [`echo '$(${W})'`, false],
  [`echo "${W}; x"`, false],
  [`echo hi && \\\n${W}`, true],
  [`echo hi \\\n&& ${W}`, true],
  [`echo don\\'t; ${W}`, true],
  [`echo $'don\\'t'; ${W}`, true],
  [`# Let's open the pull request\n${W}`, true],
  [`echo hi # don't \\\n${W}`, true],
  [`echo a#b'\n${W}'`, false],
  [`echo a\\ #b; ${W}`, true], // an escaped blank doesn’t end a word, so no comment starts
  [`echo \${x:-a #b}; ${W}`, true],
  [`echo $$'\\'; ${W} #'`, true], // $$ is the shell’s process id: no $'' starts
  [`echo a\\>|${W}`, true], // an escaped > is no redirect, so | pipes
  [`echo "$( (true); ${W} )"`, true],
  [`(( x = 1 << 2 ))\n${W}`, true],
];

test('a write is found wherever the shell runs it, and not in a heredoc’s body, which is data', () => {
  const ask = WRITE_TOOLS.map((rule) => ({ rule, source: 'writes', unless: [] }));
  for (const [command, runs] of ROWS) {
    assert.equal(isWriteCall('Bash', { command }), runs, command);
    // The panel’s effective view reads it the same way: the writes rule asks.
    const d = decide({ call: `Bash(${command})`, rules: { deny: [], ask, allow: [] }, mode: 'bypass', cwd: '/', home: '/' });
    assert.equal(d.decision === 'ask', runs, command);
  }
});

test('the parts are the commands the shell runs, each command substitution’s too', () => {
  assert.deepEqual(splitCommand(`cat > notes.md <<'EOF'\ndon't\nEOF\n${W}`), [`cat > notes.md <<'EOF'\ndon't\nEOF`, W]);
  assert.deepEqual(splitCommand(`echo $(${W}) & ls`), [W, `echo $(${W})`, 'ls']);
  assert.deepEqual(splitCommand('ls 2>&1 >| out &> all'), ['ls 2>&1 >| out &> all']);
  // When the scanner can’t tell, as with a quote that never ends (which bash refuses), the rest is read as commands
  // too, so a write in it is still checked.
  assert.ok(isWriteCall('Bash', { command: `echo 'oops; ${W}` }));
  assert.ok(isWriteCall('Bash', { command: `echo "$(echo ') && ${W}` }));
  // So is a heredoc’s body with no delimiter line, which bash reads as data, since the << may have been a shift.
  assert.ok(isWriteCall('Bash', { command: `cat > notes.md <<'EOF'\n${W}` }));
  assert.ok(isWriteCall('Bash', { command: `echo $[1<<2]\n${W}` }));
  // And nested deeper than the scan goes, each piece between operators is a part.
  assert.ok(isWriteCall('Bash', { command: `echo ${'$('.repeat(100)}${W}` }));
  assert.ok(isWriteCall('Bash', { command: `${'bash <<E\n'.repeat(100)}${W}` }));
});

// As above, run under bash: true where it printed RAN, so the shell ran a second command.
test("chains reads a comment, $'' and a process substitution as the shell does", () => {
  const M = 'echo R""AN >&2';
  for (const [command, ran] of [
    [`echo hi # don't\n${M}`, true], // a quote in a comment opens nothing
    [`echo hi # don't \\\n${M}`, true], // and a comment ends at its line, even after a backslash
    [`echo a#b'\n${M}'`, false], // a # inside a word starts no comment
    [`cat <<'EOF' # don't\nx\nEOF\n${M}`, true],
    [`echo $'don\\'t'; ${M}`, true], // in $'', a backslash escapes a quote
    ["echo $'a;b'", false],
    [`cat <(${M})`, true], // a process substitution runs a command, as $( ) does
    [`bash <<'EOF'\n${M}\nEOF`, true], // and so does a shell reading its body
    [`cat <<'EOF'\na; ${M}\nEOF`, false],
  ])
    assert.equal(chains(command), ran, command);
});
