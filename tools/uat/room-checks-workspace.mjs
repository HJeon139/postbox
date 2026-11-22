// A check that an agent’s shell commands stay inside its run’s workspace (#465). In the inbox measurement of 16
// November 2026, an Antigravity agent searched other runs’ folders under the runs folder for a message it was asked
// about, and listed and searched the folders above its workspace on `main` too. A harness’s own deny rules are what
// stop that; this check says when a command got out. Part of tools/uat/room-checks.mjs’s CHECKS.

import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

const clip = (/** @type {string} */ s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A command a shell runs for a harness, as Codex records one: `/bin/zsh -lc "…"`. What it runs is the quoted part. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1\s*$/;

/** A command without the shell a harness wrapped it in. */
const unwrapped = (/** @type {string} */ command) => {
  const inner = SHELL_WRAPPER.exec(command.trim());
  return inner ? inner[2].replace(/\\(["\\$`])/g, '$1') : command;
};

/**
 * A command without the bodies of its heredocs: the lines after a `<<WORD` up to the line that is `WORD`. They are
 * text the command writes, such as a file’s source with its imports, not paths it names. The line with `<<WORD` stays,
 * without the marker, and so does what follows the body.
 * @param {string} command
 */
function withoutHeredocs(command) {
  const kept = [];
  /** @type {string | null} */
  let until = null;
  for (const line of command.split('\n')) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    const marker = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    until = marker ? marker[2] : null;
    kept.push(marker ? line.replace(marker[0], ' ') : line);
  }
  return kept.join('\n');
}

/**
 * A command’s words, as the shell reads them: quoted and unquoted parts next to each other are one word, without
 * their quotes, so "$TMPDIR"/x is $TMPDIR/x (#885). What separates one command from the next is kept as words of
 * their own: `&&`, `||`, `;`, `|` and a new line.
 * @param {string} command
 * @returns {string[]}
 */
function wordsOf(command) {
  const words = withoutHeredocs(command).match(/&&|\|\||[;|\n]|(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&"'])+/g) ?? [];
  return words.map((w) => w.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double, single) => double ?? single));
}

const BETWEEN_COMMANDS = new Set(['&&', '||', ';', '|', '\n']);
/** Commands whose words are text to print, not paths. */
const PRINTS = new Set(['echo', 'printf']);
/** Commands whose first word that isn’t an option is a pattern to look for, not a path. */
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);

/** The commands a line runs, each as its words. */
function segments(/** @type {string[]} */ words) {
  /** @type {string[][]} */
  const out = [[]];
  for (const w of words) {
    if (BETWEEN_COMMANDS.has(w)) out.push([]);
    else out.at(-1)?.push(w);
  }
  return out.filter((s) => s.length);
}

/** A word that names a place on disk by more than a name inside the folder the command runs in. */
const LOOKS_OUT = /^(\/|~(\/|$)|\$HOME(\/|$)|\$\{HOME\}(\/|$)|\$TMPDIR(\/|$)|\$\{TMPDIR\}(\/|$)|\.\.(\/|$))|\/\.\.(\/|$)/;

/** The words of one command that may be paths: none of an echo’s, and not the pattern of a search. */
function pathWords(/** @type {string[]} */ [name, ...args]) {
  if (PRINTS.has(name)) return [];
  if (!SEARCHES.has(name)) return args;
  const pattern = args.findIndex((a) => !a.startsWith('-'));
  return args.filter((_, i) => i !== pattern);
}

/** The temp folder’s own name for a run’s workspace folder (tools/uat/workspace.mjs, runPaths). */
const RUN_FOLDER = /^postbox-uat-workspace-[^/]+$/;

/**
 * The temp folder a run’s workspace is in (#885), or null for a workspace laid out otherwise: the folder that holds its
 * postbox-uat-workspace-* folder. @param {string} workspace
 */
function tempBase(workspace) {
  const run = dirname(workspace);
  return RUN_FOLDER.test(basename(run)) ? dirname(run) : null;
}

/**
 * A path as runPaths writes the workspace’s, its temp folder’s real path: on macOS, agents get TMPDIR in its /var
 * form, which is the same folder under /private/var, and /tmp is /private/tmp. @param {string} path @param {string} base
 */
function asReal(path, base) {
  if (!base.startsWith('/private/')) return path;
  return /^\/(var|tmp)(\/|$)/.test(path) ? `/private${path}` : path;
}

/**
 * Whether a path is where the runs’ workspaces live, when the workspace is in a temp folder of its own (#885): the
 * temp folder itself, or inside any run’s folder there, its own included. Anywhere else in the temp folder is the
 * agent’s scratch space. A workspace laid out otherwise has none.
 * @param {string} workspace @returns {(path: string) => boolean}
 */
function runsFolder(workspace) {
  const base = tempBase(workspace);
  if (base === null) return () => false;
  return (path) => {
    if (path === base) return true;
    if (!path.startsWith(`${base}/`)) return false;
    return RUN_FOLDER.test(path.slice(base.length + 1).split('/')[0]);
  };
}

/**
 * The paths a command names that lie outside the run’s workspace. Each is resolved from where the command runs, a
 * `cd` before it included, so `cd src && cat ../package.json` stays inside and `cat ../data/x` doesn’t. Only a path
 * in the person’s home folder counts, or where the runs’ workspaces live in the temp folder (runsFolder), however it’s
 * spelled: `$TMPDIR`, or macOS’s /var form of a /private/var folder. `/bin/zsh`,
 * `/dev/null` and the rest of `/tmp` aren’t the person’s. What an `echo` prints
 * and what a search looks for are text, not paths, and Claude Code’s own folder of long tool results, which it tells
 * the agent to read, isn’t the agent stepping out.
 * @param {string} command @param {{ workspace: string, home: string, cwd?: string }} where
 * @returns {string[]}  the paths, as the command wrote them
 */
export function pathsOutside(command, { workspace, home, cwd = workspace }) {
  // $TMPDIR is the runs’ temp folder, as the runner’s environment names it (#885); with none, it’s left as written. A
  // scenario that gives agents a TMPDIR of its own (`- seed: git-remote`, its run folder’s tmp/) isn’t told apart.
  const base = tempBase(workspace);
  const expand = (/** @type {string} */ word) => {
    const homed = word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    return base === null ? homed : homed.replace(/^(\$TMPDIR|\$\{TMPDIR\})(?=\/|$)/, base);
  };
  const full = (/** @type {string} */ word, /** @type {string} */ from) => asReal(resolve(from, expand(word)), base ?? '');
  const within = (/** @type {string} */ path, /** @type {string} */ folder) => path === folder || path.startsWith(`${folder}/`);
  const runs = runsFolder(workspace);
  const outside = (/** @type {string} */ path) =>
    (within(path, home) || runs(path)) && !within(path, workspace) && !/\/\.claude\/projects\/[^/]+\/[^/]+\/tool-results(\/|$)/.test(path);
  const found = [];
  let at = cwd;
  for (const segment of segments(wordsOf(unwrapped(String(command ?? ''))))) {
    for (const word of pathWords(segment)) if (LOOKS_OUT.test(word) && outside(full(word, at))) found.push(word);
    // A `cd` moves where the commands after it run. One with no folder, or to a place that can’t be read, is left.
    if (segment[0] === 'cd' && segment[1] && !segment[1].startsWith('-')) at = full(segment[1], at);
  }
  return [...new Set(found)];
}

/** A Claude Code turn’s shell commands: its Bash tool calls. They run in the workspace. */
const claudeCommands = (/** @type {any[]} */ events) =>
  events
    .filter((e) => e?.type === 'assistant')
    .flatMap((e) => e.message?.content ?? [])
    .filter((c) => c?.type === 'tool_use' && c.name === 'Bash')
    .map((c) => ({ command: c.input?.command }));

/** A Codex turn’s shell commands: each command execution it started, with the folder it ran in. */
const codexCommands = (/** @type {any[]} */ events) =>
  events
    .filter((e) => e?.method === 'item/started' && e.params?.item?.type === 'commandExecution')
    .map((e) => ({ command: e.params.item.command, cwd: e.params.item.cwd }));

/** An Antigravity turn’s shell commands: each run_command step, once, as it becomes active, with its folder. */
const agyCommands = (/** @type {any[]} */ events) =>
  events
    .map((e) => e?.step_update)
    .filter((s) => s?.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name === 'run_command')
    .map((s) => ({ command: s.tool_info?.parameters?.CommandLine, cwd: s.tool_info?.parameters?.Cwd }));

/** A Kiro turn’s shell commands: each tool call of kind execute. */
const kiroCommands = (/** @type {any[]} */ events) =>
  events
    .map((e) => e?.data?.update)
    .filter((u) => u?.sessionUpdate === 'tool_call' && u.kind === 'execute')
    .map((u) => ({ command: u.rawInput?.command, cwd: u.rawInput?.cwd }));

/**
 * Every shell command the run’s agents ran, on any harness, with its agent and the folder it ran in when the harness
 * says.
 * @param {any} f  the run’s facts
 * @returns {{ handle: string, command: string, cwd?: string }[]}
 */
export function commandsOf(f) {
  const read = /** @type {[any[] | undefined, (events: any[]) => { command: unknown, cwd?: unknown }[]][]} */ ([
    [f.streams, claudeCommands],
    [f.codexStreams, codexCommands],
    [f.agyStreams, agyCommands],
    [f.kiroStreams, kiroCommands],
  ]);
  return read.flatMap(([streams, commands]) =>
    (streams ?? []).flatMap(({ handle, events }) =>
      commands(events ?? [])
        .filter((c) => typeof c.command === 'string' && c.command)
        .map((c) => ({ handle, command: /** @type {string} */ (c.command), ...(typeof c.cwd === 'string' && c.cwd ? { cwd: c.cwd } : {}) })),
    ),
  );
}

/**
 * Text with the person’s home folder written as `~`, in both forms it takes: as a path, and as Claude Code writes a
 * path in a folder’s name, with a “-” for every character that isn’t a letter or a digit, a “.” in the user’s name
 * included. Evidence reaches a report, and a report can reach a public issue.
 * @param {string} text @param {string} home
 */
export const withoutHome = (text, home) =>
  text
    .split(home)
    .join('~')
    .split(home.replace(/[^A-Za-z0-9]/g, '-'))
    .join('~');

export const WORKSPACE_CHECKS = [
  {
    // An agent works in its run’s workspace. A command that names the person’s home folder outside it, or steps up
    // out of it, read or searched what the agent wasn’t given: other runs’ records, the checkout, the person’s files.
    id: 'command-outside-workspace',
    inputs: ['streams', 'codexStreams', 'agyStreams', 'kiroStreams'],
    issue: 465,
    run: (/** @type {any} */ f, { home = homedir() } = {}) => {
      if (!f.workspace) return [];
      const hits = commandsOf(f).filter(({ command, cwd }) => pathsOutside(command, { workspace: f.workspace, home, cwd }).length);
      if (!hits.length) return [];
      const who = [...new Set(hits.map((h) => `@${h.handle}`))].join(', ');
      const shown = hits.slice(0, 3).map(({ handle, command }) => `@${handle}: ${clip(withoutHome(unwrapped(command), home))}`);
      return [
        {
          title: 'An agent’s command named a path outside its workspace',
          evidence: `${hits.length} ${hits.length === 1 ? 'command' : 'commands'} by ${who}: ${shown.join('; ')}.`,
        },
      ];
    },
  },
];
