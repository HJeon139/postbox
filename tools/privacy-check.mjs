/**
 * The privacy checker for committed text, kept apart from its test so a CI tool can reuse it (#508). Its own file and
 * its test are checked like any other, so the examples in these comments name each part generically, and the test
 * builds its examples at run time.
 *
 * Known gaps, which it lets through:
 * - a token with a “_” and more name characters run on before or after it, where a word boundary never comes;
 * - a token or an address split across two lines, except a stream’s deltas, which are joined and checked again;
 * - a path whose slashes are JSON-escaped (a backslash before each “/”) or URL-encoded (“%2F”);
 * - a home written as “~” and a user name, and root’s home under “/root”;
 * - a leak after a zero byte early in a file, which is then counted as binary and not read;
 * - a real account named “me” or “you” in a slug, which reads as the placeholder;
 * - UTF-16 text, read as UTF-8 with a zero byte after each ASCII character;
 * - a Bearer token shorter than 20 characters, and a token under another scheme, such as Basic;
 * - a uid under another key, such as “user_id”, and account data under keys other than the six account fields;
 * - a connector a person named after one of claude.ai’s directory connectors;
 * - a connector’s tool ids, “mcp__claude_ai_<name>__<tool>”, where its name shows as surely as in mcp_servers.
 */

import { joinedDeltas } from './joined-deltas.mjs';

/** Placeholder user names a slashed home path may use, compared in lower case. “someone” is the tests’ made-up home. */
const ALLOWED_USERNAMES = new Set(['me', 'you', 'user', 'someone']);

/**
 * Placeholder user names a slug may use, compared in lower case. A slug turns every “/” and “.” into “-”, so a slug of
 * the placeholder “user” and a folder can’t be told from a real account whose name starts with “user” and a “.” or
 * “-”, and “user” is the placeholder that most often starts a real name. A slashed path keeps the name whole, so “user”
 * stays allowed there.
 */
const ALLOWED_SLUG_USERNAMES = new Set(['me', 'you']);

/** Home folders that belong to a system account, not a person: Homebrew on Linux installs under its own home. */
const SYSTEM_HOMES = new Set(['linuxbrew']);

// A home folder, Unix or Windows (“Users” or “home” in any case, as macOS paths are case-insensitive, then a “/” or
// “\”), and the user name after it. It starts where no name character comes before: after a “/” or “\” (a Windows
// drive’s too, so the drive needs no pattern of its own), or at the start of the text. The slashes before it aren’t
// part of the match, so a long run of them is no slower. A name doesn’t start with a dot, so a shell script’s
// “$home/.nvm” is a folder in a home, not a user, and one after a “$” is a shell variable, such as “$HOME/x”.
const SLASHED_HOME = /(?<![A-Za-z0-9_$-])((?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee]))[/\\]+([a-zA-Z0-9_][a-zA-Z0-9._-]*)/g;

// A web address, up to the first space, quote or bracket.
const WEB_URL = /https?:\/\/[^\s"'<>()[\]]+/g;

// A Claude Code project slug: a path with each “/” and “.” turned into “-”. It starts with a “-” that follows no slug
// character, so a word with “-home-” inside it in prose isn’t one. On Windows the drive letter comes first and its “:”
// and “\” each become a “-”.
const SLUG = /(?<![A-Za-z0-9_.-])(?:[A-Za-z]-)?-[A-Za-z0-9_.-]+/g;

// A home folder inside a slug, in any case, and the user name after it, up to the next “-”.
const SLUG_HOME = /-(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee])-([A-Za-z0-9_.]+)/g;

// macOS temp folders (slashed or slugged), and Claude Code’s temp folder with its uid. A slugged one starts at a “-”
// that follows no other “-”, so a run of dashes is tried once.
const TEMP_FOLDER = /(?:\/(?:private\/)?var\/folders\/|(?<!-)-+(?:private-)?var-folders-|\/(?:private\/)?tmp\/claude-\d+\/)[a-zA-Z0-9._-]*/g;

// Claude Code’s temp folder uid without its slashes, bare or in a slug. A uid has three digits or more (macOS starts at
// 501, Linux at 1000), so a model name such as “claude-3-5” isn’t one. The random name of the file a shell writes its
// folder to ends in “-cwd”, and its digits aren’t a uid.
const CLAUDE_UID = /(?<![A-Za-z0-9])claude-(\d{3,})(?![A-Za-z0-9]|-cwd\b)/g;

// A scrubbed id: all zeros, with or without dashes.
const ALL_ZEROS = /^0+(?:-0+)*$/;

// Codex’s installationId or installation_id, and its value. Each quote may follow a “\”, as it does where the JSON is
// escaped inside another string, so the value stops at a “\” too.
const INSTALLATION_ID = /\\?"installation(?:Id|_id)\\?"\s*:\s*\\?"([^"\\]+)\\?"/g;

// Account metadata keys, camelCase and snake_case.
const ACCOUNT_KEYS = 'planType|authMode|usedPercent|plan_type|auth_mode|used_percent';

// An account key in quotes, with or without a “\” before each, or bare before a “:” or an “=”, as YAML, a JavaScript
// object and TOML (Codex’s config.toml) write one (#696). A bare key after a name character is part of a longer name,
// and one before “==” is a comparison, not a value.
const ACCOUNT_FIELD = new RegExp(`\\\\?"(${ACCOUNT_KEYS})\\\\?"|(?<![A-Za-z0-9_$])(${ACCOUNT_KEYS})(?=\\s*(?::|=(?!=)))`, 'g');

// A “uid” field and its number, quoted or not, with or without a “\” before each quote (#696).
const UID_FIELD = /\\?"uid\\?"\s*:\s*\\?"?(\d+)/g;

// A claude.ai connector in an init’s mcp_servers, by its “name”, with or without a “\” before each quote.
const CLAUDE_AI_CONNECTOR = /\\?"name\\?"\s*:\s*\\?"claude\.ai ([^"\\]+)\\?"/g;

/**
 * The connectors claude.ai’s directory offers, named alike for every account, as a recorded init lists them
 * (tests/fixtures/claude-code/host-mcp-init.jsonl). A connector a person adds has the name they give it, which may be
 * their own (#661), and no shape tells it from the directory’s, so every other name is flagged.
 */
const DIRECTORY_CONNECTORS = new Set(['Claude Docs', 'Gmail', 'Google Calendar', 'Google Drive']);

// Anthropic API keys and GitHub tokens, at the lengths server/telemetry-secrets.mjs matches, so a placeholder such as
// “sk-ant-...” or “ghp_xxxx” in prose isn’t one. A Bearer token (RFC 6750’s characters, the scheme in either case) is
// 20 characters or more, so “Bearer token” in prose, “<token>” and a shell’s “$TOKEN” aren’t one (#696).
const API_TOKEN = /\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}|\b[Bb]earer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/g;

// A rate limit’s “utilization”, how much of the account’s limit it used, and its value, with or without a “\” before
// each quote. Only 0 says nothing.
const UTILIZATION = /\\?"utilization\\?"\s*:\s*([^,}\]\s]+)/g;

// The value a scrubbed utilization holds.
const ZERO = /^0(?:\.0+)?$/;

// An email address. It stops at the first character an address can’t hold, so an address with “_” and a name run on
// after it is still the address. It starts where no address character comes before, so a long run of them with no “@”
// is tried once, not once from each of its characters.
const EMAIL = /(?<![a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

// A placeholder address: at a domain reserved for examples (example.com, .org or .net, or a subdomain of one), or under
// a top-level domain reserved for examples and tests (RFC 2606).
const EXAMPLE_EMAIL = /@(?:(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net)|(?:[A-Za-z0-9-]+\.)+(?:example|test|invalid|localhost))$/;

/**
 * Addresses that belong to no person: the agents’ commit authors, the user of every GitHub SSH remote, and the two the
 * mention tests write to check that “@indexer” and “@critic” inside an address aren’t mentions of those agents.
 */
const BOT_EMAILS = new Set(['noreply@anthropic.com', 'noreply@openai.com', 'git@github.com', 'a@indexer.com', 'x@critic.com']);

/**
 * Text shaped like an address that isn’t one, each matched exactly. “plugins.sample@test.mcp” is the start of a Codex
 * TOML key, “plugins.sample@test.mcp_servers…”, in tests/codex-mcp-approval.test.mjs: a plugin named “sample” from the
 * “test” marketplace. Listing that one string, rather than skipping “.mcp” or anything followed by “_”, keeps every
 * other address checked.
 */
const NOT_EMAILS = new Set(['plugins.sample@test.mcp']);

/**
 * A private string a rule found: its kind, the string, kept only to match a placeholder and never printed, and where in
 * the text it starts.
 * @typedef {{ kind: string, value: string, index: number }} Found
 */

/** Home paths, slashed or in a slug, whose user name isn’t a placeholder. @param {string} content @returns {Found[]} */
function homePaths(content) {
  const found = [];
  const urls = [...content.matchAll(WEB_URL)].map((url) => [url.index, url.index + url[0].length]);
  for (const match of content.matchAll(SLASHED_HOME)) {
    const [path, folder, name] = match;
    // A web page’s path with “users” or “home” in another case than a disk’s, such as a docs section, is no home.
    const inUrl = urls.some(([start, end]) => match.index >= start && match.index < end);
    if (inUrl && folder !== 'Users' && folder !== 'home') continue;
    const user = name.split(/[/\\]/)[0];
    if (!ALLOWED_USERNAMES.has(user.toLowerCase()) && !SYSTEM_HOMES.has(user)) found.push({ kind: 'home path', value: path, index: match.index });
  }
  for (const slug of content.matchAll(SLUG)) {
    for (const home of slug[0].matchAll(SLUG_HOME)) {
      if (!ALLOWED_SLUG_USERNAMES.has(home[1].toLowerCase())) found.push({ kind: 'home path', value: home[0], index: slug.index + home.index });
    }
  }
  return found;
}

/** Temp folders, and Claude Code uids that aren’t all zeros. @param {string} content @returns {Found[]} */
function tempPaths(content) {
  const found = [];
  for (const match of content.matchAll(TEMP_FOLDER)) found.push({ kind: 'temp folder path', value: match[0], index: match.index });
  for (const match of content.matchAll(CLAUDE_UID)) {
    if (!ALL_ZEROS.test(match[1])) found.push({ kind: 'claude uid', value: match[0], index: match.index });
  }
  return found;
}

/**
 * Each match of a pattern whose first group doesn’t pass as harmless.
 * @param {string} content @param {RegExp} pattern @param {string} kind @param {(value: string) => boolean} harmless
 * @returns {Found[]}
 */
function valuesOf(content, pattern, kind, harmless) {
  const found = [];
  for (const match of content.matchAll(pattern)) {
    if (!harmless(match[1])) found.push({ kind, value: match[1], index: match.index });
  }
  return found;
}

/** Every match of a pattern, of one kind. @param {string} content @param {RegExp} pattern @param {string} kind @returns {Found[]} */
function matchesOf(content, pattern, kind) {
  return [...content.matchAll(pattern)].map((match) => ({ kind, value: match[0], index: match.index }));
}

/** Whether an address is a placeholder or no person’s. @param {string} email */
function placeholderEmail(email) {
  return EXAMPLE_EMAIL.test(email) || BOT_EMAILS.has(email) || NOT_EMAILS.has(email);
}

/** What every rule finds in a text. @param {string} content @returns {Found[]} */
function privateStrings(content) {
  return [
    ...homePaths(content),
    ...tempPaths(content),
    ...valuesOf(content, UID_FIELD, 'uid', (uid) => ALL_ZEROS.test(uid)),
    ...valuesOf(content, INSTALLATION_ID, 'installationId', (id) => ALL_ZEROS.test(id.replace(/\s/g, ''))),
    ...matchesOf(content, ACCOUNT_FIELD, 'account field'),
    ...valuesOf(content, CLAUDE_AI_CONNECTOR, 'connector name', (name) => DIRECTORY_CONNECTORS.has(name)),
    ...matchesOf(content, API_TOKEN, 'token'),
    ...valuesOf(content, UTILIZATION, 'utilization', (value) => ZERO.test(value)),
    ...valuesOf(content, EMAIL, 'email', placeholderEmail),
  ];
}

/**
 * The line each offset of a text is on, from 1, by a binary search of its line breaks, so a text with many findings is
 * read once.
 * @param {string} content
 * @returns {(index: number) => number}
 */
function lineFinder(content) {
  const breaks = [];
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) breaks.push(at);
  return (index) => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (breaks[middle] < index) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

/** A line number as it is. @param {number} line */
const sameLine = (line) => line;

/**
 * Checks text for leaked personal data or un-sanitized environment paths: home paths with a real user name, temp
 * folders, Claude Code uids and uid fields, a real Codex installation id, account metadata, a claude.ai connector a
 * person named, API keys and tokens, a utilization other than 0, and real email addresses.
 *
 * Each violation names its kind and its line, “email at line 3”, and never any part of what it found: CI prints them to
 * its log, which is public and kept for 90 days, so a masked address or a token’s first characters would outlast the
 * commit that held them (#784).
 *
 * @param {string} content
 * @param {(line: number) => number} [lineOf] the line to report for a line of content, when content is part of a file
 * @returns {string[]} list of violations found
 */
export function checkContentPrivacy(content, lineOf = sameLine) {
  const lineAt = lineFinder(content);
  return privateStrings(content).map(({ kind, index }) => `${kind} at line ${lineOf(lineAt(index))}`);
}

/** Where a violation in a file’s name says it is. */
const IN_FILE_NAME = 'in the file name';

/**
 * Checks a committed file’s name, by its path from the repository’s root: a name is published as surely as what the
 * file holds (#785).
 *
 * @param {string} path
 * @returns {string[]} list of violations found
 */
export function checkPathPrivacy(path) {
  return privateStrings(path).map(({ kind }) => `${kind} ${IN_FILE_NAME}`);
}

/**
 * Whether a violation is in a file’s name, so that a report mustn’t print the name. @param {string} violation
 */
export function inFileName(violation) {
  return violation.endsWith(IN_FILE_NAME);
}

/**
 * Checks one committed file, by its path from the repository’s root, with the placeholders its joined deltas may hold.
 *
 * @param {string} path
 * @param {string} content
 * @param {(line: number) => number} [lineOf] the line to report for a line of content, when content is part of a file
 * @returns {string[]} list of violations found
 */
export function checkFilePrivacy(path, content, lineOf = sameLine) {
  const violations = checkContentPrivacy(content, lineOf);
  if (!path.endsWith('.jsonl')) return violations;
  const allowed = ALLOWED_JOINED.get(path) ?? [];
  for (const stream of joinedDeltas(content)) {
    const leaks = privateStrings(stream.text).filter(
      ({ kind, value }) => !allowed.some((placeholder) => placeholder.kind === kind && placeholder.value === value),
    );
    violations.push(...leaks.map(({ kind }) => `${kind} in the deltas joined from line ${lineOf(stream.firstLine)}`));
  }
  return violations;
}

/**
 * Placeholders a recorded stream’s joined deltas hold, by file: the prompt in permission-allow.jsonl names a made-up
 * project folder, “postbox”, where a home’s user name goes. Each entry is the kind and the exact string it allows.
 */
const MADE_UP_HOME = ['Users', 'postbox'].join('/'); // joined at run time, so this file doesn’t hold the path itself
const ALLOWED_JOINED = new Map([['tests/fixtures/claude-code/permission-allow.jsonl', [{ kind: 'home path', value: MADE_UP_HOME }]]]);

/** Whether a file is binary, as git decides it: a zero byte in its first 8,000. @param {Buffer} bytes */
export function isBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Checks each file of a tree, its name and what it holds, read by its path, whatever its size. A binary file’s name is
 * checked, but not its bytes, and it isn’t counted; a file the reader can’t find is skipped.
 *
 * @param {string[]} paths paths from the repository’s root
 * @param {(path: string) => Buffer | null} read the file’s bytes, or null when it’s gone
 * @returns {{ checked: number, findings: { path: string, violations: string[] }[] }}
 */
export function checkFilesPrivacy(paths, read) {
  const findings = [];
  let checked = 0;
  for (const path of paths) {
    const bytes = read(path);
    if (bytes === null) continue;
    const violations = checkPathPrivacy(path);
    if (!isBinary(bytes)) {
      checked++;
      violations.push(...checkFilePrivacy(path, bytes.toString('utf8')));
    }
    if (violations.length > 0) findings.push({ path, violations });
  }
  return { checked, findings };
}
