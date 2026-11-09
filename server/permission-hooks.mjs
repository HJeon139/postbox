// The hooks in the settings files an agent reads that can approve a tool call, for the permissions panel (#817, #871).
// Postbox’s own settings turn hooks off in Ask me and Accept edits (settingsFor in server/adapters/setup.mjs, and
// shared/hook-modes.mjs), since there a hook that approves a call skips the ask rules for writes outside Postbox and the
// permission card; in Auto and Run everything they run (#806). The panel names each such hook it finds there, with its
// event, so the person knows which of theirs run in Postbox turns, and in which modes.
// Org-managed hooks aren’t read here: they still run. Plugins’ hooks aren’t either: Claude Code documents where a
// plugin is turned on (enabledPlugins) but not where its hooks are kept, so the panel says it can’t list them.
//
// A hook’s matcher and command are the person’s data. They reach the page as text through h(), cut to a length, with
// control characters and characters that show as nothing marked, and with the credentials found in either hidden, as
// best it can (a matcher is a pattern the person writes, so it can hold one too, #871). A file that isn’t JSON, or
// holds hooks in a shape this doesn’t know, says so.

import { readFile } from 'node:fs/promises';
import { INVISIBLE } from '../shared/invisible.mjs';
import { HOST_SOURCES, ISOLATED_SOURCES } from './adapters/setup.mjs';
import { settingsFiles } from './permission-rules.mjs';
import { KEY_SHAPES } from './telemetry-secrets.mjs';

const MAX_HOOKS = 50; // per file, as read: the rest are counted
const MAX_TEXT = 200;
const MAX_MATCHER = 100;
const MAX_TYPE = 20;

// The hook events that can approve a tool call or change its input, in the order the panel lists them. A PreToolUse
// hook answers with permissionDecision and updatedInput; a PermissionRequest hook with decision.behavior allow and
// updatedInput (PreToolUseHookSpecificOutput and PermissionRequestHookSpecificOutput in the Agent SDK’s sdk.d.ts).
const APPROVING_EVENTS = /** @type {const} */ (['PreToolUse', 'PermissionRequest']);

/**
 * A string as one line of text: a tab or line break (U+2028 and U+2029 too) is a space, and another control character
 * or a character that shows as nothing (INVISIBLE, shared/invisible.mjs) the replacement mark.
 * @param {string} v
 */
const marked = (v) =>
  v
    .replace(/[\t\n\r\u2028\u2029]/g, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 and C1 control characters are exactly what this marks
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '\uFFFD')
    .replace(INVISIBLE, '\uFFFD');

/** Text past `max` cut with an ellipsis. @param {string} v @param {number} max */
const cut = (v, max) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/** A string as one line of text at most `max` long, marked as `marked` does. @param {unknown} v @param {number} max */
const shown = (v, max) => (typeof v === 'string' ? cut(marked(v), max) : '');

// Credentials in a hook’s text, hidden before it leaves the server (#817, #927): GET /api/permissions carries it to the
// page. They’re looked for once the text is marked, so a character that shows as nothing, now the replacement mark, can
// sit in a name. Best effort only: it reads a command as a shell would split words, and a credential under another
// name, or passed some other way, still shows. The values it finds become an ellipsis:
// - a URL’s userinfo, a user and password or a token alone (https://…@host),
// - a name with key, token, secret or password in it, then = (NAME=v, --api-key=v, ?token=v in an address),
// - a flag named so, then its value after a space (--token v), unless the next word is a flag,
// - a header named so, or Authorization (keeping its scheme), then a colon (X-Api-Key: v, Authorization: Basic v),
// - a Cookie header’s cookies, to the quote that ends the header, or the end of the text,
// - a JSON field named so, when its value is a string ("token": "v", or \"token\": \"v\" inside a shell’s quotes),
// - a query parameter for a signature or a credential under another name (?sig=v, &X-Amz-Credential=v),
// - Bearer and the token after it,
// - a token with a known prefix and no name before it (KEY_SHAPES, server/telemetry-secrets.mjs: ghp_, sk-, AKIA…),
//   and a GitLab token (glpat-).
// A value is a quoted string (to the end of the text when its quote never closes) or a word ending at a space, a quote
// or one of & ; | < > ( ) `.
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s'"&;|<>()\x60]+)`;
const WORD = String.raw`[^\s'"&;|<>()\x60]+`;
const NAMED = String.raw`[\w\uFFFD-]*(?:key|token|secret|password)[\w\uFFFD-]*`;
const USERINFO = /\b([a-z][\w+.-]*:\/\/)[^\s/?#@'"<>&;|()`]+(?=@)/gi;
// lint-allow regex: built from VALUE and NAMED, the constants just above.
const ASSIGNED = new RegExp(String.raw`(?<![\w-])(${NAMED}=)${VALUE}`, 'gi');
// lint-allow regex: built from VALUE and NAMED, the constants just above.
const FLAGGED = new RegExp(String.raw`(?<![\w-])(--?${NAMED}\s+)(?!-)${VALUE}`, 'gi');
// lint-allow regex: built from VALUE, WORD and NAMED, the constants just above.
const HEADER = new RegExp(String.raw`(?<![\w-])(${NAMED}:[ \t]*)${VALUE}|\b(authorization:[ \t]*(?:[a-z][\w-]*[ \t]+)?)${WORD}`, 'gi');
const COOKIE = /\b(cookie:[ \t]*)[^'"]+/gi;
// lint-allow regex: built from NAMED, the constant just above.
const JSON_FIELD = new RegExp(String.raw`(\\"${NAMED}\\"\s*:\s*\\")[^"\\]*|("${NAMED}"\s*:\s*")(?:[^"\\]|\\.)*`, 'gi');
const SIGNED = /([?&](?:sig|signature|auth|x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential)=)[^\s'"&;|<>()`#]+/gi;
const BEARER = /\b(bearer\s+)[^\s'"&;|<>()`]+/gi;
const BARE = [...KEY_SHAPES, /\bglpat-[\w-]{20,}/g];
// The patterns that keep a name, each with its name in its first group or, in another alternative, its second.
const NAME_PATTERNS = [USERINFO, ASSIGNED, FLAGGED, HEADER, COOKIE, JSON_FIELD, SIGNED, BEARER];

// How much of a text is searched, well past what the panel shows: the name patterns backtrack on a long run of letters,
// so this bounds the work a hostile settings file can make.
const MAX_SCAN = 2000;

/** A match’s name, from whichever of its pattern’s alternatives matched, then an ellipsis. */
const keptName = (_match, name, other) => `${name ?? other}…`;

/** `text`, cut to MAX_SCAN and marked, with the credentials found in it replaced by an ellipsis. @param {string} text */
function redacted(text) {
  const kept = NAME_PATTERNS.reduce((s, pattern) => s.replace(pattern, keptName), marked(text.slice(0, MAX_SCAN)));
  return BARE.reduce((s, pattern) => s.replace(pattern, '…'), kept);
}

/**
 * A hook group’s matcher as the panel shows it, with the credentials found in it hidden. No matcher, or an empty one,
 * matches every tool, as Claude Code reads it.
 * @param {any} group
 */
const matcherOf = (group) => (typeof group.matcher === 'string' ? cut(redacted(group.matcher), MAX_MATCHER) : '') || '*';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * One hook as the panel shows it, with its event. A command hook shows its command; a prompt or an http hook, its
 * prompt or address, with the credentials found in it hidden.
 * @param {string} event @param {string} matcher @param {any} hook
 */
function entry(event, matcher, hook) {
  const type = shown(isObject(hook) && typeof hook.type === 'string' ? hook.type : 'command', MAX_TYPE);
  const text = isObject(hook) ? (hook.command ?? hook.prompt ?? hook.url) : '';
  return { event, matcher, type, text: typeof text === 'string' ? cut(redacted(text), MAX_TEXT) : '' };
}

/** Whether an event’s hook groups are in the shape Claude Code reads: a list of objects, each with a list of hooks. */
const knownShape = (groups) => Array.isArray(groups) && groups.every((g) => isObject(g) && Array.isArray(g.hooks));

/**
 * One settings file’s hooks on APPROVING_EVENTS, or why they can’t be listed. A missing file has none. One event’s
 * hooks in a shape this doesn’t know fail the whole file, rather than list it in part.
 * @param {string} file
 * @returns {Promise<{ file: string, exists: boolean, hooks: { event: string, matcher: string, type: string, text: string }[], more: number, error?: string }>}
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
  const byEvent = APPROVING_EVENTS.map((event) => [event, Object.hasOwn(settings.hooks, event) ? settings.hooks[event] : undefined]);
  const listed = byEvent.filter(([, groups]) => groups !== undefined);
  if (!listed.every(([, groups]) => knownShape(groups))) return unknown;
  const all = listed.flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((hook) => entry(event, matcherOf(g), hook))));
  return { file, exists: true, hooks: all.slice(0, MAX_HOOKS), more: Math.max(0, all.length - MAX_HOOKS) };
}

/**
 * The hooks on APPROVING_EVENTS of each settings source an agent reads, the same sources its turns load
 * (HOST_SOURCES or ISOLATED_SOURCES, server/adapters/setup.mjs): the user’s only when the persona loads the person’s
 * setup.
 * @param {{ folder: string, home: string, configDir?: string|null, usesHostSetup: boolean }} opts
 */
export async function readHooks({ folder, home, configDir = null, usesHostSetup }) {
  const files = settingsFiles(folder, home, configDir);
  const sources = usesHostSetup ? HOST_SOURCES : ISOLATED_SOURCES;
  return Promise.all(sources.map(async (source) => ({ source, ...(await readHookFile(files[source])) })));
}
