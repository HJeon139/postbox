// Claude Code permission rules for a refused tool call: the exact rule that allows it once, a broader one
// for “Always allow”, and saving that one where the CLI saves “don’t ask again” (.claude/settings.local.json
// in the agent’s folder), so Postbox and the terminal share it. Rule syntax: Tool or Tool(specifier),
// e.g. Bash(npm test:*), WebFetch(domain:example.com), Edit(/abs/path).

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chains } from '../shared/command-chains.mjs';

export { chains };

// Commands whose second word is the real command (git status, npm test): “always” allows that pair.
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'pip', 'cargo', 'go', 'make', 'docker', 'kubectl', 'gh']);
// Interpreters by any version (python3.12, pypy3, node22): like TWO_WORD, allowed only with the script they run.
const INTERPRETER = /^(python|pypy|node|nodejs|bun)[\d.]*$/;
// Any other command with shell syntax in it (a redirect, a quoted | or ;) only ever gets its exact text allowed.
const COMPOUND = /[|;&`<>]|\$\(/;
// Programs that run the command or code after them: a rule for their name (Bash(env:*), Bash(perl:*)) would allow any
// command or any code, since Claude Code doesn’t strip them (#281), so they only ever get their exact text allowed.
const WRAPPERS = new Set(
  'bash sh zsh dash ksh fish env xargs sudo doas su nohup time nice timeout exec command builtin eval perl ruby php lua awk gawk deno ssh osascript pwsh'.split(
    ' ',
  ),
);

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
};

/**
 * once and always are null, and why says which, for a chained command, which no one rule can allow (chains), and for
 * one with a *, which Claude Code reads in a Bash rule as a wildcard, so its rule would allow more than the command.
 * @param {string} tool
 * @param {Record<string, any>} [input]
 * @returns {{ once: string|null, always: string|null, alwaysWords: string, why?: 'chained' | 'wildcard' }}
 */
export function rulesFor(tool, input = {}) {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': {
      const cmd = String(i.command ?? '').trim();
      if (!cmd) return { once: 'Bash', always: 'Bash', alwaysWords: 'any command' };
      const exact = `Bash(${cmd})`;
      if (chains(cmd)) return { once: null, always: null, alwaysWords: '', why: 'chained' };
      // `rm -rf build/*`’s rule would allow `rm -rf build/ ~` too (#281).
      if (cmd.includes('*')) return { once: null, always: null, alwaysWords: '', why: 'wildcard' };
      const words = cmd.split(/\s+/);
      const program = words[0].slice(words[0].lastIndexOf('/') + 1); // /usr/bin/node is node
      const exactly = { once: exact, always: exact, alwaysWords: `exactly “${cmd}”` };
      if (COMPOUND.test(cmd) || WRAPPERS.has(program)) return exactly;
      // A program whose second word says what it runs (git status, npm test, python3 tools/a.py) is allowed only with
      // that word. With a flag there (`node -e`, `python3 -c`, `git -c`), or none, the rule for the program alone would
      // allow any code, so only the exact text (#281). Versioned interpreters (python3.12, pypy3) count too.
      if (!TWO_WORD.has(program) && !INTERPRETER.test(program))
        return { once: exact, always: `Bash(${words[0]}:*)`, alwaysWords: `commands that start with “${words[0]}”` };
      if (!words[1] || words[1].startsWith('-') || !/^[\w:./-]+$/.test(words[1])) return exactly;
      const prefix = `${words[0]} ${words[1]}`;
      return { once: exact, always: `Bash(${prefix}:*)`, alwaysWords: `commands that start with “${prefix}”` };
    }
    case 'WebFetch': {
      const host = hostOf(i.url);
      return host
        ? { once: `WebFetch(domain:${host})`, always: `WebFetch(domain:${host})`, alwaysWords: `fetching pages from ${host}` }
        : { once: 'WebFetch', always: 'WebFetch', alwaysWords: 'fetching any page' };
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = i.file_path ?? i.notebook_path;
      const verb = tool === 'Read' ? 'reading' : 'changing';
      return path
        ? { once: `${tool}(${path})`, always: `${tool}(${path})`, alwaysWords: `${verb} ${path}` }
        : { once: tool, always: tool, alwaysWords: `${verb} any file` };
    }
    default:
      return { once: tool, always: tool, alwaysWords: `using ${tool}` };
  }
}

/** Adds an allow rule to <folder>/.claude/settings.local.json, keeping everything else in the file. */
export async function addAllowRule(folder, rule) {
  const { file, changed } = await changeRule(settingsFiles(folder, '').local, { behavior: 'allow', rule });
  return { file, added: changed };
}

// ── The permissions panel (#66) ──────────────────────────────────────────────────────────
// The rules an agent runs with come from the settings files Claude Code reads, merged: the person’s user settings
// (only when the persona loads their setup), the project’s shared settings, and the folder’s local settings, where
// the CLI saves “don’t ask again”. The panel reads each with its source and changes the ones Postbox may write.

export const BEHAVIORS = /** @type {const} */ (['allow', 'ask', 'deny']);
const MAX_RULES = 500; // per list, as read: a file with more is shown cut
const MAX_RULE = 500;

/**
 * The settings files for an agent’s folder. user is the person’s own; project is shared with their team (checked
 * in), so Postbox shows it and never writes it; local is this computer’s, for this folder. configDir is
 * CLAUDE_CONFIG_DIR, which Claude Code reads the user settings from instead of ~/.claude (its own code joins
 * settings.json to that folder).
 * @param {string} folder @param {string} home @param {string|null} [configDir]
 */
export function settingsFiles(folder, home, configDir = null) {
  return {
    user: join(configDir || join(home, '.claude'), 'settings.json'),
    project: join(folder, '.claude', 'settings.json'),
    local: join(folder, '.claude', 'settings.local.json'),
  };
}

/**
 * A rule as Claude Code writes it: a tool name, which may hold `*` (`mcp__github`, `mcp__*__send_*`), and an
 * optional specifier in parentheses (`Bash(npm test:*)`, `WebFetch(domain:example.com)`, `Read(./src/**)`).
 * Returns the rule trimmed, or null when it isn’t one.
 * @param {unknown} rule
 */
export function cleanRule(rule) {
  if (typeof rule !== 'string') return null;
  const r = rule.trim();
  return r.length <= MAX_RULE && /^[A-Za-z*][\w.*-]*(?:\([^\n]+\))?$/.test(r) && (!r.includes('(') || r.endsWith(')')) ? r : null;
}

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, MAX_RULES) : []);

/**
 * One settings file: its permission rules and extra folders, or why it couldn’t be read. A missing file is empty.
 * @param {string} file
 */
export async function readSettingsFile(file) {
  let settings;
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { file, exists: false, allow: [], ask: [], deny: [], dirs: [] };
    return { file, exists: true, error: `${file} isn’t valid JSON, so Postbox can’t read its rules or change it.`, allow: [], ask: [], deny: [], dirs: [] };
  }
  const p = settings && typeof settings === 'object' && settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  return { file, exists: true, allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny), dirs: strings(p.additionalDirectories) };
}

/**
 * The rules from each settings source an agent reads. The user source only when the persona loads the person’s
 * setup (`--setting-sources user,project,local`); an Isolated one reads project and local only.
 * @param {{ folder: string, home: string, configDir?: string|null, usesHostSetup: boolean }} opts
 */
export async function readRules({ folder, home, configDir = null, usesHostSetup }) {
  const files = settingsFiles(folder, home, configDir);
  /** @type {('user'|'project'|'local')[]} */
  const sources = usesHostSetup ? ['user', 'project', 'local'] : ['project', 'local'];
  return Promise.all(sources.map(async (source) => ({ source, writable: source !== 'project', ...(await readSettingsFile(files[source])) })));
}

/** Changes queued per settings file, so two at once can’t read the same file and lose one of them. */
const writing = new Map();

/**
 * Adds a rule to one list of a settings file, or removes it, keeping everything else in the file. Changes to one
 * file run one at a time. Written atomically, to a temporary file of its own beside the real file, renamed over it:
 * a settings file that’s a link (into a dotfiles repository, say) stays a link, and its target changes. A file that
 * isn’t JSON is the person’s, so it’s never overwritten.
 * @param {string} file @param {{ behavior: 'allow'|'ask'|'deny', rule: string, remove?: boolean }} change
 * @returns {Promise<{ file: string, changed: boolean }>}
 */
export function changeRule(file, change) {
  const key = resolve(file);
  const run = () => writeRule(file, change);
  const done = (writing.get(key) ?? Promise.resolve()).then(run, run);
  const settled = done.then(
    () => {},
    () => {},
  );
  writing.set(key, settled);
  settled.then(() => {
    if (writing.get(key) === settled) writing.delete(key);
  });
  return done;
}

/** @param {string} file @param {{ behavior: 'allow'|'ask'|'deny', rule: string, remove?: boolean }} change */
async function writeRule(file, { behavior, rule, remove = false }) {
  // The file itself, through any links; a missing one is created where it’s named.
  const target = await realpath(file).catch((e) => {
    if (e.code === 'ENOENT') return file;
    throw e;
  });
  /** @type {any} */
  let settings = {};
  try {
    settings = JSON.parse(await readFile(target, 'utf8'));
  } catch (e) {
    // A missing file starts empty; one that isn’t JSON is the person’s, so don’t overwrite it.
    if (e.code !== 'ENOENT') throw Object.assign(new Error(`${file} isn’t valid JSON, so Postbox didn’t change it.`), { status: 409 });
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw Object.assign(new Error(`${file} doesn’t hold settings, so Postbox didn’t change it.`), { status: 409 });
  const list = Array.isArray(settings.permissions?.[behavior]) ? settings.permissions[behavior] : [];
  const has = list.includes(rule);
  if (has !== remove) return { file, changed: false };
  const next = remove ? list.filter((r) => r !== rule) : [...list, rule];
  settings = { ...settings, permissions: { ...settings.permissions, [behavior]: next } };
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, target);
  return { file, changed: true };
}

/**
 * The settings overlay (`--settings`, the SDK’s `settings`) with a conversation’s ask rules (#66). Allow and deny
 * rules for a conversation go in `--allowedTools` and `--disallowedTools`; ask has no flag, so it goes in the
 * overlay’s `permissions.ask`, the settings key the person’s own files use, which Claude Code merges with theirs.
 * @param {Record<string, any>} overlay @param {string[]|undefined} ask
 */
export function withAskRules(overlay, ask) {
  return ask?.length ? { ...overlay, permissions: { ...(overlay.permissions ?? {}), ask: [...ask] } } : overlay;
}

// ── Always allow on a permission card (#66, #10) ─────────────────────────────────────────
// Every prompt carries Claude Code’s own suggestions (`permission_suggestions` from the CLI’s prompt tool, the SDK’s
// `suggestions`): the exact changes behind “don’t ask again”. Returning them as `updatedPermissions` applies them.

const DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);
const SDK_MODES = { default: 'ask', acceptEdits: 'accept edits', plan: 'plan', dontAsk: 'don’t ask', auto: 'auto', bypassPermissions: 'run everything' };
const WHERE = {
  localSettings: 'in this folder (.claude/settings.local.json)',
  userSettings: 'everywhere you use Claude Code (~/.claude/settings.json)',
};

/** A suggested rule as Claude Code writes it: Bash(npm test:*). */
const ruleText = (r) => `${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}`;

/**
 * What Always allow sends back, and the same in words, from a prompt’s suggestions; null when there’s nothing to
 * allow always. Rules go to this folder’s local settings, as the CLI saves “don’t ask again”, and as #66 decided
 * for rules made in Postbox. So a rule suggested for the session only, which in Postbox would end with the turn
 * (each turn is a new Claude Code session), or for the project’s shared settings, which belong to the person’s
 * team, is saved in the local file instead, and `moved` says so. A rule for the person’s user settings stays there.
 * A mode or a folder for the session stays as suggested: it lasts for the rest of the turn.
 * @param {unknown} suggestions
 * @returns {{ updates: any[], lines: { text: string, rule?: string }[], moved: string|null } | null}
 */
export function alwaysAllow(suggestions) {
  if (!Array.isArray(suggestions)) return null;
  const updates = [];
  const lines = [];
  /** @type {string|null} */
  let moved = null;
  for (const s of suggestions.slice(0, 20)) {
    if (!s || typeof s !== 'object' || !DESTINATIONS.has(s.destination)) continue;
    if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      // A rule that wouldn’t fit the panel’s bound is left out whole: cutting it short would make another rule.
      const rules = s.rules
        .filter((r) => r && typeof r.toolName === 'string' && r.toolName && (r.ruleContent === undefined || typeof r.ruleContent === 'string'))
        .map((r) => ({ toolName: r.toolName, ...(r.ruleContent ? { ruleContent: r.ruleContent } : {}) }))
        .filter((r) => cleanRule(ruleText(r)) === ruleText(r))
        .slice(0, 20);
      if (!rules.length) continue;
      const destination = s.destination === 'userSettings' ? 'userSettings' : 'localSettings';
      if (destination !== s.destination)
        moved =
          s.destination === 'projectSettings'
            ? 'Claude Code suggested the project’s shared settings. Postbox saves it in this folder’s local settings instead, so your team’s file stays as it is.'
            : 'Claude Code suggested this for its session only. Each Postbox turn is a new Claude Code session, so Postbox saves it in this folder’s local settings instead, where the CLI saves “don’t ask again”.';
      updates.push({ type: 'addRules', rules, behavior: 'allow', destination });
      for (const r of rules) lines.push({ text: `Always allow ${ruleText(r)} ${WHERE[destination]}`, rule: ruleText(r) });
    } else if (s.type === 'setMode' && Object.hasOwn(SDK_MODES, s.mode)) {
      // Only for the rest of the turn. Saved as a default mode, it would change a settings file (the project’s, which
      // the panel never writes, or the person’s own), and Postbox passes the mode with every turn anyway.
      if (s.destination !== 'session' && s.destination !== 'cliArg') continue;
      updates.push({ type: 'setMode', mode: s.mode, destination: 'session' });
      lines.push({ text: `Switch to ${SDK_MODES[s.mode]} mode for the rest of this turn` });
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories)) {
      const directories = s.directories.filter((d) => typeof d === 'string' && d && d.length <= 1000).slice(0, 20);
      if (!directories.length) continue;
      const destination = s.destination === 'session' || s.destination === 'cliArg' ? 'session' : 'localSettings';
      updates.push({ type: 'addDirectories', directories, destination });
      lines.push({ text: `Let it work in ${directories.join(', ')} ${destination === 'session' ? 'for the rest of this turn' : WHERE.localSettings}` });
    }
  }
  return updates.length ? { updates, lines, moved } : null;
}
