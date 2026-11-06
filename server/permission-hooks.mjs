// The PreToolUse hooks in the settings files an agent reads, for the permissions panel (#817). Postbox’s own settings
// turn hooks off in every mode but bypass (settingsFor in server/adapters/setup.mjs), since a hook that approves a call
// skips the ask rules for writes outside Postbox and the permission card. The panel names each hook it finds there, so
// the person knows which of theirs won’t run in Postbox turns. Org-managed hooks aren’t read here: they still run.
//
// A hook’s matcher and command are the person’s data. They reach the page as text through h(), cut to a length and
// with control characters and characters that show as nothing marked, and a file that isn’t JSON, or holds hooks in a
// shape this doesn’t know, says so.

import { readFile } from 'node:fs/promises';
import { settingsFiles } from './permission-rules.mjs';

const MAX_HOOKS = 50; // per file, as read: the rest are counted
const MAX_TEXT = 200;
const MAX_MATCHER = 100;
const MAX_TYPE = 20;

// Characters that change how text around them displays, or that display as nothing: every format character (Cf:
// zero-width ones, soft hyphens, word joiners, invisible operators, tag characters, U+FEFF), the bidi marks,
// embeddings, overrides and isolates, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the combining grapheme
// joiner (U+034F) and the variation selectors (U+FE00 to U+FE0F), which are marks rather than format characters, and the
// whole tag block (U+E0000 to U+E007F), whose unassigned code points aren’t Cf. A right-to-left override can make a
// command read as another one.
// The two marks are alternatives of their own: in one class with other characters, Biome reads them as combining.
const INVISIBLE = /[\p{Cf}\p{Bidi_Control}\u115f\u1160\u3164\uffa0\u{e0000}-\u{e007f}]|\u034f|[\ufe00-\ufe0f]/gu;

/**
 * A string as one line of text at most `max` long: a tab or line break (U+2028 and U+2029 too) is a space, another
 * control character or a character that shows as nothing (INVISIBLE) the replacement mark, and text past the limit
 * is cut with an ellipsis.
 * @param {unknown} v @param {number} max
 */
function shown(v, max) {
  if (typeof v !== 'string') return '';
  const one = v
    .replace(/[\t\n\r\u2028\u2029]/g, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 and C1 control characters are exactly what this marks
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '\uFFFD')
    .replace(INVISIBLE, '\uFFFD');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * One hook as the panel shows it. A command hook shows its command; a prompt or an http hook, its prompt or address.
 * @param {string} matcher @param {any} hook
 */
function entry(matcher, hook) {
  const type = shown(isObject(hook) && typeof hook.type === 'string' ? hook.type : 'command', MAX_TYPE);
  const text = isObject(hook) ? (hook.command ?? hook.prompt ?? hook.url) : '';
  return { matcher, type, text: shown(text, MAX_TEXT) };
}

/**
 * One settings file’s PreToolUse hooks, or why they can’t be listed. A missing file has none.
 * @param {string} file
 * @returns {Promise<{ file: string, exists: boolean, hooks: { matcher: string, type: string, text: string }[], more: number, error?: string }>}
 */
export async function readHookFile(file) {
  let settings;
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { file, exists: false, hooks: [], more: 0 };
    const error =
      e instanceof SyntaxError
        ? `${file} isn’t valid JSON, so Postbox can’t list its hooks.`
        : `Postbox couldn’t read ${file} (${e.code}), so it can’t list its hooks.`;
    return { file, exists: true, hooks: [], more: 0, error };
  }
  const unknown = { file, exists: true, hooks: [], more: 0, error: `${file} has hooks in a shape Postbox doesn’t know, so it can’t list them.` };
  if (!isObject(settings) || settings.hooks === undefined) return { file, exists: true, hooks: [], more: 0 };
  if (!isObject(settings.hooks)) return unknown;
  const groups = settings.hooks.PreToolUse;
  if (groups === undefined) return { file, exists: true, hooks: [], more: 0 };
  if (!Array.isArray(groups) || !groups.every((g) => isObject(g) && Array.isArray(g.hooks))) return unknown;
  // No matcher, or an empty one, matches every tool, as Claude Code reads it.
  const all = groups.flatMap((g) => g.hooks.map((hook) => entry(shown(g.matcher, MAX_MATCHER) || '*', hook)));
  return { file, exists: true, hooks: all.slice(0, MAX_HOOKS), more: Math.max(0, all.length - MAX_HOOKS) };
}

/**
 * The PreToolUse hooks of each settings source an agent reads: the user’s only when the persona loads the person’s
 * setup, as for its rules (permission-rules.mjs, readRules).
 * @param {{ folder: string, home: string, configDir?: string|null, usesHostSetup: boolean }} opts
 */
export async function readHooks({ folder, home, configDir = null, usesHostSetup }) {
  const files = settingsFiles(folder, home, configDir);
  /** @type {('user'|'project'|'local')[]} */
  const sources = usesHostSetup ? ['user', 'project', 'local'] : ['project', 'local'];
  return Promise.all(sources.map(async (source) => ({ source, ...(await readHookFile(files[source])) })));
}
