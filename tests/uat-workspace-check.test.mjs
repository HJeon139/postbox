// An agent’s shell commands stay inside its run’s workspace (#465; tools/uat/room-checks-workspace.mjs). The commands
// below are ones an Antigravity agent ran in the inbox measurement of 16 November 2026, with the home folder renamed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKS } from '../tools/uat/room-checks.mjs';
import { commandsOf, pathsOutside, WORKSPACE_CHECKS, withoutHome } from '../tools/uat/room-checks-workspace.mjs';

const home = '/Users/me';
const runs = `${home}/postbox/uat-runs`;
const workspace = `${runs}/2026-11-16T01-09-59-inboxroom/workspace`;
const where = { workspace, home };
// The shell’s spelling of the home folder with braces, built here so the linter doesn’t read it as a template’s.
const braced = ['$', '{HOME}/x'].join('');

test('a command that names the home folder outside the workspace is outside, however the path is written', () => {
  assert.deepEqual(pathsOutside(`grep -rn "Find the newest message" ${runs}/ 2>/dev/null`, where), [`${runs}/`]);
  assert.deepEqual(pathsOutside(`find ${home}/postbox -name "*CHANGELOG*" -o -name "*changelog*"`, where), [`${home}/postbox`]);
  assert.deepEqual(pathsOutside(`ls ~/.ssh "$HOME/.claude" ${braced}`, where), ['~/.ssh', '$HOME/.claude', braced]);
  // Another run’s folder beside this one starts with the same letters as far as “uat-runs/”.
  assert.equal(pathsOutside(`sed -n 1,9p ${runs}/2026-11-16T01-03-50-inboxroom/data/events-1.jsonl`, where).length, 1);
  // Through the workspace and out again: the path starts inside it.
  assert.deepEqual(pathsOutside(`cat ${workspace}/../data/events-1.jsonl`, where), [`${workspace}/../data/events-1.jsonl`]);
});

test('a step up is judged from where the command runs, a cd before it included', () => {
  assert.deepEqual(pathsOutside('ls -la ..', where), ['..']);
  assert.deepEqual(pathsOutside('cat ../data/events-1.jsonl', where), ['../data/events-1.jsonl']);
  assert.deepEqual(pathsOutside('cd src && cat ../package.json', where), [], 'up from a folder inside it is still inside');
  assert.deepEqual(pathsOutside('cd src; npm test -- ../tests', where), []);
  assert.deepEqual(pathsOutside('cd src && cat ../../data/x', where), ['../../data/x']);
  assert.deepEqual(pathsOutside('cd .. && ls', where), ['..'], 'a cd out is itself outside');
  // The folder a harness says the command ran in.
  assert.deepEqual(pathsOutside('cat ../package.json', { ...where, cwd: `${workspace}/src` }), []);
  assert.deepEqual(pathsOutside('ls ..', { ...where, cwd: workspace }), ['..']);
});

test('a command that stays in the workspace, names the computer’s own paths, or only prints or searches for a path isn’t outside', () => {
  assert.deepEqual(pathsOutside('ls -la', where), []);
  assert.deepEqual(pathsOutside(`cat ${workspace}/CHANGELOG.md && git status; git log -n 5`, where), []);
  assert.deepEqual(pathsOutside('/bin/zsh -lc "rg -n -i release ." 2>/dev/null > /tmp/out', where), []);
  assert.deepEqual(pathsOutside('echo "wait..." && node a.js --flag=..x && git diff a..b', where), []);
  assert.deepEqual(pathsOutside(`echo "see ${home}/notes and ../data"`, where), [], 'what an echo prints is text');
  assert.deepEqual(pathsOutside(`grep -rn "${home}/postbox" . && rg '../data' src`, where), [], 'what a search looks for is text');
  assert.deepEqual(pathsOutside(`grep -rn "x" ${home}/postbox`, where), [`${home}/postbox`], 'where it searches is a path');
  // Claude Code keeps a long tool result in its own folder, and tells the agent to read it there.
  const kept = `${home}/.claude/projects/-Users-me-postbox/0b1c/tool-results/toolu_01.txt`;
  assert.deepEqual(pathsOutside(`cat ${kept}`, where), []);
  assert.deepEqual(pathsOutside(`cat ${home}/.claude/projects/-Users-me-postbox/0b1c.jsonl`, where).length, 1, 'its transcripts aren’t that');
});

test('a command a harness wrapped in a shell is read as the command inside', () => {
  assert.deepEqual(pathsOutside('/bin/zsh -lc "ls -la .."', where), ['..']);
  assert.deepEqual(pathsOutside(`/bin/zsh -lc "cat \\"${home}/notes.txt\\""`, where), [`${home}/notes.txt`]);
  assert.deepEqual(pathsOutside('/bin/zsh -lc "rg -n \\"release 2\\\\.1\\" ."', where), []);
});

test('every harness’s shell commands are read from its own stream, with the folder they ran in when it says', () => {
  const f = {
    streams: [
      {
        handle: 'researcher',
        events: [
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
                { type: 'tool_use', name: 'Read', input: {} },
              ],
            },
          },
        ],
      },
    ],
    codexStreams: [
      {
        handle: 'critic',
        events: [{ method: 'item/started', params: { item: { type: 'commandExecution', command: '/bin/zsh -lc "rg x ."', cwd: workspace } } }],
      },
    ],
    agyStreams: [
      {
        handle: 'developer',
        events: [
          {
            step_update: {
              step_type: 'tool',
              state: 'ACTIVE',
              tool_name: 'run_command',
              tool_info: { parameters: { CommandLine: 'ls -la ..', Cwd: `${workspace}/src` } },
            },
          },
          { step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls -la ..' } } } },
          { step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { Path: '/x' } } } },
        ],
      },
    ],
    kiroStreams: [{ handle: 'alpha', events: [{ data: { update: { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'pwd' } } } }] }],
  };
  assert.deepEqual(commandsOf(f), [
    { handle: 'researcher', command: 'ls' },
    { handle: 'critic', command: '/bin/zsh -lc "rg x ."', cwd: workspace },
    { handle: 'developer', command: 'ls -la ..', cwd: `${workspace}/src` },
    { handle: 'alpha', command: 'pwd' },
  ]);
});

const step = (/** @type {string} */ command) => ({
  step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: command } } },
});

test('command-outside-workspace: a run where an agent searched other runs’ folders is flagged', () => {
  const check = WORKSPACE_CHECKS[0];
  assert.ok(CHECKS.includes(check), 'the runner’s checks include it');
  const f = { workspace, agyStreams: [{ handle: 'developer', events: [step('ls -la'), step(`grep -rn "Find" ${runs}/ 2>/dev/null`)] }] };
  const found = check.run(f, { home });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence, '1 command by @developer: @developer: grep -rn "Find" ~/postbox/uat-runs/ 2>/dev/null.');
  assert.deepEqual(
    check.run({ workspace, agyStreams: [{ handle: 'developer', events: [step('ls -la'), step('cd src && cat ../package.json')] }] }, { home }),
    [],
  );
  assert.deepEqual(check.run({ agyStreams: f.agyStreams }, { home }), [], 'a run that doesn’t say where its workspace is isn’t judged');
});

test('the evidence never holds the person’s user name, as a path or as Claude Code writes one in a folder’s name', () => {
  assert.equal(withoutHome(`cat ${home}/x /tmp/scratch/-Users-me-postbox--claude/y`, home), 'cat ~/x /tmp/scratch/~-postbox--claude/y');
  const dashed = `ls ${home}/.claude/projects/-Users-me-postbox && cat /tmp/scratch/-Users-me-postbox/scratch/../../../${home}/secret`;
  const f = { workspace, agyStreams: [{ handle: 'developer', events: [step(dashed), step(`find ${home} -name id_rsa`)] }] };
  const [found] = WORKSPACE_CHECKS[0].run(f, { home });
  assert.ok(found, 'both commands are outside');
  assert.ok(!found.evidence.includes('Users'), found.evidence);
});

test('a heredoc’s body is text a command writes, not paths it names', () => {
  const written = ['cat > src/app.mjs <<EOF', "import x from '../lib/db.mjs';", 'const home = "~/notes";', 'EOF', 'node src/app.mjs'].join('\n');
  assert.deepEqual(pathsOutside(written, where), []);
  // Quoted and dashed markers, as a shell takes them.
  assert.deepEqual(pathsOutside(["cat <<'TXT' > a.txt", 'see ../../secrets', 'TXT'].join('\n'), where), []);
  assert.deepEqual(pathsOutside(['cat <<-END', '\t../up', '\tEND'].join('\n'), where), []);
  // What comes before and after the body is still the command’s.
  assert.deepEqual(pathsOutside(['cat > ../out.txt <<EOF', 'body', 'EOF', 'ls ..'].join('\n'), where), ['../out.txt', '..']);
});

test('the dashed form of a home with a dot in the user’s name is written as ~ too', () => {
  // Claude Code turns every character that isn’t a letter or a digit into “-”. The name is put together here so this
  // file holds no home path the privacy check would read as a real one.
  const dotted = ['', 'Users', ['pat', 'lee'].join('.')].join('/');
  const slug = ['', 'Users', 'pat', 'lee', 'postbox'].join('-');
  assert.equal(withoutHome(`ls ${dotted}/x /tmp/scratch/${slug}/y`, dotted), 'ls ~/x /tmp/scratch/~-postbox/y');
});

test('with the workspace in a temp folder of its own (#885), a step out of it into that folder or another run’s is outside', () => {
  // As runPaths makes it: <TMPDIR>/postbox-uat-workspace-XXXXXX/workspace, outside the person’s home.
  const base = '/tmp/pb-uat-base';
  const tmpWhere = { workspace: `${base}/postbox-uat-workspace-abc123/workspace`, home: '/Users/someone' };
  assert.deepEqual(pathsOutside('ls ..', tmpWhere), ['..'], 'its own temp folder');
  assert.deepEqual(pathsOutside('ls ../..', tmpWhere), ['../..'], 'the temp base, where every run’s folder is');
  assert.deepEqual(pathsOutside('grep -r answer ../../', tmpWhere), ['../../']);
  assert.deepEqual(
    pathsOutside('cat ../../postbox-uat-workspace-def/workspace/notes.md', tmpWhere),
    ['../../postbox-uat-workspace-def/workspace/notes.md'],
    'another run’s workspace',
  );
  assert.deepEqual(pathsOutside(`cat ${base}/postbox-uat-workspace-def/workspace/notes.md`, tmpWhere), [
    `${base}/postbox-uat-workspace-def/workspace/notes.md`,
  ]);
  // The rest of the temp folder is the agent’s scratch space, not a step out.
  assert.deepEqual(pathsOutside(`echo hi > ${base}/scratch.txt && cat ${base}/scratch.txt`, tmpWhere), []);
  assert.deepEqual(pathsOutside('cat /tmp/notes.txt', tmpWhere), []);
  assert.deepEqual(pathsOutside('cd src && cat ../package.json', tmpWhere), [], 'and inside the workspace is inside');
});

test('on macOS, a step into the runs’ temp folder written as $TMPDIR or by its /var form is outside too (#885)', () => {
  // macOS’s per-user temp folder, built from parts so the privacy check (tools/privacy-check.mjs) doesn’t read it as one.
  const tmp = ['', 'var', 'folders', 'ab', 'xyz', 'T'].join('/');
  // runPaths takes the temp folder’s real path, under /private; agents get TMPDIR in its /var form from their
  // environment, unresolved, and write it either way.
  const tmpWhere = { workspace: `/private${tmp}/postbox-uat-workspace-abc/workspace`, home: '/Users/someone' };
  assert.deepEqual(pathsOutside('ls $TMPDIR', tmpWhere), ['$TMPDIR']);
  assert.deepEqual(pathsOutside('ls "$TMPDIR"', tmpWhere), ['$TMPDIR']);
  const bracedTmp = ['$', '{TMPDIR}/'].join('');
  assert.deepEqual(pathsOutside(`ls ${bracedTmp}`, tmpWhere), [bracedTmp]);
  assert.deepEqual(pathsOutside('cat $TMPDIR/postbox-uat-workspace-def/workspace/notes.md', tmpWhere), [
    '$TMPDIR/postbox-uat-workspace-def/workspace/notes.md',
  ]);
  assert.deepEqual(pathsOutside(`ls ${tmp}`, tmpWhere), [tmp]);
  assert.deepEqual(pathsOutside(`cat ${tmp}/postbox-uat-workspace-def/workspace/notes.md`, tmpWhere), [`${tmp}/postbox-uat-workspace-def/workspace/notes.md`]);
  // Its own workspace through $TMPDIR is inside, and the rest of the temp folder is still scratch space.
  assert.deepEqual(pathsOutside('cat $TMPDIR/postbox-uat-workspace-abc/workspace/notes.md', tmpWhere), []);
  assert.deepEqual(pathsOutside(`echo hi > $TMPDIR/scratch.txt && cat ${tmp}/scratch.txt`, tmpWhere), []);
  // On Linux, $TMPDIR, when it’s set, is the temp base as written.
  const linux = { workspace: '/tmp/postbox-uat-workspace-abc/workspace', home: '/home/someone' };
  assert.deepEqual(pathsOutside('ls $TMPDIR', linux), ['$TMPDIR']);
  assert.deepEqual(pathsOutside('cat /tmp/postbox-uat-workspace-def/workspace/x', linux), ['/tmp/postbox-uat-workspace-def/workspace/x']);
});

test('a word in quoted and unquoted parts is one word, as the shell reads it, so "$TMPDIR"/x is scratch, not the temp folder', () => {
  const tmp = ['', 'var', 'folders', 'ab', 'xyz', 'T'].join('/');
  const tmpWhere = { workspace: `/private${tmp}/postbox-uat-workspace-abc/workspace`, home: '/Users/someone' };
  assert.deepEqual(pathsOutside('cp a "$TMPDIR"/s', tmpWhere), [], 'a scratch file');
  assert.deepEqual(pathsOutside('cat a > "$TMPDIR"/s.txt && cat "$TMPDIR"/s.txt', tmpWhere), []);
  assert.deepEqual(
    pathsOutside('cat "$TMPDIR"/postbox-uat-workspace-def/workspace/x', tmpWhere),
    ['$TMPDIR/postbox-uat-workspace-def/workspace/x'],
    'another run’s, quoted in part',
  );
  assert.deepEqual(pathsOutside(`cat "$HOME"/.ssh/id_rsa`, where), ['$HOME/.ssh/id_rsa'], 'the same for $HOME');
  assert.deepEqual(pathsOutside(`cat '..'/data/x`, where), ['../data/x']);
});
