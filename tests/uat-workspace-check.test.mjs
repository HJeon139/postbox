// An agent’s shell commands stay inside its run’s workspace (#465; tools/uat/room-checks-workspace.mjs). The commands
// below are ones an Antigravity agent ran in the inbox measurement of 16 November 2026, with the home folder renamed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKS } from '../tools/uat/room-checks.mjs';
import { commandsOf, pathsOutside, WORKSPACE_CHECKS } from '../tools/uat/room-checks-workspace.mjs';

const home = '/Users/pat';
const workspace = '/Users/pat/postbox/uat-runs/2026-11-16T01-09-59-inboxroom/workspace';
const where = { workspace, home };

test('a command that names the home folder outside the workspace, or steps up from it, is outside', () => {
  assert.deepEqual(pathsOutside('grep -rn "Find the newest message" /Users/pat/postbox/uat-runs/ 2>/dev/null', where), ['/Users/pat/postbox/uat-runs/']);
  assert.deepEqual(pathsOutside('find /Users/pat/postbox -name "*CHANGELOG*" -o -name "*changelog*"', where), ['/Users/pat/postbox']);
  assert.deepEqual(pathsOutside('ls -la ..', where), ['..']);
  // The shell’s other spelling of the home folder, built here so the linter doesn’t read it as a template’s.
  const braced = ['$', '{HOME}/x'].join('');
  assert.deepEqual(pathsOutside(`cat ../data/events-1.jsonl; ls ~/.ssh "$HOME/.claude" ${braced}`, where), [
    '../data/events-1.jsonl',
    '~/.ssh',
    '$HOME/.claude',
    braced,
  ]);
  // Another run’s folder beside this one starts with the same letters as far as “uat-runs/”.
  assert.deepEqual(pathsOutside('sed -n 1,9p /Users/pat/postbox/uat-runs/2026-11-16T01-03-50-inboxroom/data/events-1.jsonl', where).length, 1);
});

test('a command that stays in the workspace, or names the computer’s own paths, isn’t', () => {
  assert.deepEqual(pathsOutside('ls -la', where), []);
  assert.deepEqual(pathsOutside(`cat ${workspace}/CHANGELOG.md && git status; git log -n 5`, where), []);
  assert.deepEqual(pathsOutside(`ls ${workspace}`, where), []);
  assert.deepEqual(pathsOutside('/bin/zsh -lc "rg -n -i release ." 2>/dev/null > /tmp/out', where), []);
  assert.deepEqual(pathsOutside('echo "wait..." && node a.js --flag=..x', where), []);
});

test('every harness’s shell commands are read from its own stream', () => {
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
      { handle: 'critic', events: [{ method: 'item/started', params: { item: { type: 'commandExecution', command: '/bin/zsh -lc "rg x ."' } } }] },
    ],
    agyStreams: [
      {
        handle: 'developer',
        events: [
          { step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls -la ..' } } } },
          { step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls -la ..' } } } },
          { step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { Path: '/x' } } } },
        ],
      },
    ],
    kiroStreams: [{ handle: 'alpha', events: [{ data: { update: { sessionUpdate: 'tool_call', kind: 'execute', rawInput: { command: 'pwd' } } } }] }],
  };
  assert.deepEqual(commandsOf(f), [
    { handle: 'researcher', command: 'ls' },
    { handle: 'critic', command: '/bin/zsh -lc "rg x ."' },
    { handle: 'developer', command: 'ls -la ..' },
    { handle: 'alpha', command: 'pwd' },
  ]);
});

test('command-outside-workspace: a run where an agent searched other runs’ folders is flagged, with the home folder as ~', () => {
  const check = WORKSPACE_CHECKS[0];
  assert.ok(CHECKS.includes(check), 'the runner’s checks include it');
  const step = (/** @type {string} */ command) => ({
    step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: command } } },
  });
  const f = { workspace, agyStreams: [{ handle: 'developer', events: [step('ls -la'), step('grep -rn "Find" /Users/pat/postbox/uat-runs/ 2>/dev/null')] }] };
  const found = check.run(f, { home });
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence, '1 command by @developer: @developer: grep -rn "Find" ~/postbox/uat-runs/ 2>/dev/null.');
  assert.deepEqual(check.run({ workspace, agyStreams: [{ handle: 'developer', events: [step('ls -la')] }] }, { home }), []);
  assert.deepEqual(check.run({ agyStreams: f.agyStreams }, { home }), [], 'a run that doesn’t say where its workspace is isn’t judged');
});
