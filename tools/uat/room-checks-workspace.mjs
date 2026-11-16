// A check that an agent’s shell commands stay inside its run’s workspace (#465). In the inbox measurement of 16
// November 2026, an Antigravity agent searched other runs’ folders under the runs folder for a message it was asked
// about, and listed and searched the folders above its workspace on `main` too. A harness’s own deny rules are what
// stop that; this check says when a command got out. Part of tools/uat/room-checks.mjs’s CHECKS.

import { homedir } from 'node:os';

const clip = (/** @type {string} */ s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What separates a command’s words: spaces, quotes, and the shell’s own marks. */
const BETWEEN_WORDS = /[\s"'`;|&()<>=]+/;

/**
 * The paths a command names that lie outside the run’s workspace: one under the person’s home folder, written out,
 * as `~/…` or as `$HOME/…`, that isn’t inside the workspace; and a step up from where the command runs, `..` or
 * `../…`. A path elsewhere on the computer, such as `/bin/zsh` or `/dev/null`, isn’t the person’s and isn’t counted.
 * @param {string} command @param {{ workspace: string, home: string }} where
 * @returns {string[]}
 */
export function pathsOutside(command, { workspace, home }) {
  const inHome = (/** @type {string} */ word) => {
    const full = word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    return (full === home || full.startsWith(`${home}/`)) && full !== workspace && !full.startsWith(`${workspace}/`);
  };
  const stepsUp = (/** @type {string} */ word) => word === '..' || word.startsWith('../');
  const words = String(command ?? '').split(BETWEEN_WORDS);
  return [...new Set(words.filter((word) => inHome(word) || stepsUp(word)))];
}

/** A Claude Code turn’s shell commands: its Bash tool calls. */
const claudeCommands = (/** @type {any[]} */ events) =>
  events
    .filter((e) => e?.type === 'assistant')
    .flatMap((e) => e.message?.content ?? [])
    .filter((c) => c?.type === 'tool_use' && c.name === 'Bash')
    .map((c) => c.input?.command);

/** A Codex turn’s shell commands: each command execution it started. */
const codexCommands = (/** @type {any[]} */ events) =>
  events.filter((e) => e?.method === 'item/started' && e.params?.item?.type === 'commandExecution').map((e) => e.params.item.command);

/** An Antigravity turn’s shell commands: each run_command step, once, as it becomes active. */
const agyCommands = (/** @type {any[]} */ events) =>
  events
    .map((e) => e?.step_update)
    .filter((s) => s?.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name === 'run_command')
    .map((s) => s.tool_info?.parameters?.CommandLine);

/** A Kiro turn’s shell commands: each tool call of kind execute. */
const kiroCommands = (/** @type {any[]} */ events) =>
  events
    .map((e) => e?.data?.update)
    .filter((u) => u?.sessionUpdate === 'tool_call' && u.kind === 'execute')
    .map((u) => u.rawInput?.command);

/**
 * Every shell command the run’s agents ran, on any harness, with its agent.
 * @param {any} f  the run’s facts
 * @returns {{ handle: string, command: string }[]}
 */
export function commandsOf(f) {
  const read = /** @type {[any[] | undefined, (events: any[]) => unknown[]][]} */ ([
    [f.streams, claudeCommands],
    [f.codexStreams, codexCommands],
    [f.agyStreams, agyCommands],
    [f.kiroStreams, kiroCommands],
  ]);
  return read.flatMap(([streams, commands]) =>
    (streams ?? []).flatMap(({ handle, events }) =>
      commands(events ?? [])
        .filter((c) => typeof c === 'string' && c)
        .map((c) => ({ handle, command: /** @type {string} */ (c) })),
    ),
  );
}

export const WORKSPACE_CHECKS = [
  {
    // An agent works in its run’s workspace. A command that names the person’s home folder outside it, or steps up
    // from it, read or searched what the agent wasn’t given: other runs’ records, the checkout, the person’s files.
    id: 'command-outside-workspace',
    inputs: ['streams', 'codexStreams', 'agyStreams', 'kiroStreams'],
    issue: 465,
    run: (/** @type {any} */ f, { home = homedir() } = {}) => {
      if (!f.workspace) return [];
      const hits = commandsOf(f).filter(({ command }) => pathsOutside(command, { workspace: f.workspace, home }).length);
      if (!hits.length) return [];
      const who = [...new Set(hits.map((h) => `@${h.handle}`))].join(', ');
      // The person’s home folder is written as ~, so a report can be shared.
      const shown = hits.slice(0, 3).map(({ handle, command }) => `@${handle}: ${clip(command.split(home).join('~'))}`);
      return [
        {
          title: 'An agent’s command named a path outside its workspace',
          evidence: `${hits.length} ${hits.length === 1 ? 'command' : 'commands'} by ${who}: ${shown.join('; ')}.`,
        },
      ];
    },
  },
];
