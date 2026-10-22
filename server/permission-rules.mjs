// Claude Code permission rules for a refused tool call: the exact rule that allows it once, a broader one
// for “Always allow”, and saving that one where the CLI saves “don’t ask again” (.claude/settings.local.json
// in the agent’s folder), so Postbox and the terminal share it. Rule syntax: Tool or Tool(specifier),
// e.g. Bash(npm test:*), WebFetch(domain:example.com), Edit(/abs/path).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Commands whose second word is the real command (git status, npm test): “always” allows that pair.
const TWO_WORD = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'pip', 'cargo', 'go', 'make', 'docker', 'kubectl', 'gh']);
// A command that chains, pipes or substitutes only ever gets its exact text allowed.
const COMPOUND = /[|;&`<>]|\$\(/;

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return null;
  }
};

/**
 * @param {string} tool
 * @param {Record<string, any>} [input]
 * @returns {{ once: string, always: string, alwaysWords: string }}
 */
export function rulesFor(tool, input = {}) {
  const i = input ?? {};
  switch (tool) {
    case 'Bash': {
      const cmd = String(i.command ?? '').trim();
      if (!cmd) return { once: 'Bash', always: 'Bash', alwaysWords: 'any command' };
      const exact = `Bash(${cmd})`;
      if (COMPOUND.test(cmd)) return { once: exact, always: exact, alwaysWords: `exactly “${cmd}”` };
      const words = cmd.split(/\s+/);
      const prefix = TWO_WORD.has(words[0]) && words[1] && /^[\w:.-]+$/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
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
  const file = join(folder, '.claude', 'settings.local.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    // A missing file starts empty; one that isn’t JSON is the person’s, so don’t overwrite it.
    if (e.code !== 'ENOENT') throw Object.assign(new Error(`${file} isn’t valid JSON, so Postbox didn’t change it.`), { status: 409 });
  }
  const allow = settings.permissions?.allow ?? [];
  if (allow.includes(rule)) return { file, added: false };
  settings = { ...settings, permissions: { ...settings.permissions, allow: [...allow, rule] } };
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, file);
  return { file, added: true };
}
