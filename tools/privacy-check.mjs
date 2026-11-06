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
 * - UTF-16 text, read as UTF-8 with a zero byte after each ASCII character.
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

// Account metadata keys (camelCase and snake_case), with or without a “\” before each quote.
const ACCOUNT_FIELD = /\\?"(planType|authMode|usedPercent|plan_type|auth_mode|used_percent)\\?"/g;

// Anthropic API keys and GitHub tokens, at the lengths server/telemetry-secrets.mjs matches, so a placeholder such as
// “sk-ant-...” or “ghp_xxxx” in prose isn’t one.
const API_TOKEN = /\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/g;

// A rate limit’s “utilization”, how much of the account’s limit it used, and its value, with or without a “\” before
// each quote. Only 0 says nothing.
const UTILIZATION = /\\?"utilization\\?"\s*:\s*([^,}\]\s]+)/g;

// The value a scrubbed utilization holds.
const ZERO = /^0(?:\.0+)?$/;

// An email address. It stops at the first character an address can’t hold, so an address with “_” and a name run on
// after it is still the address. It starts where no address character comes before, so a long run of them with no “@”
// is tried once, not once from each of its characters.
const EMAIL = /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

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

/** Home paths, slashed or in a slug, whose user name isn’t a placeholder. @param {string} content */
function homePaths(content) {
  const found = [];
  const urls = [...content.matchAll(WEB_URL)].map((url) => [url.index, url.index + url[0].length]);
  for (const match of content.matchAll(SLASHED_HOME)) {
    const [path, folder, name] = match;
    // A web page’s path with “users” or “home” in another case than a disk’s, such as a docs section, is no home.
    const inUrl = urls.some(([start, end]) => match.index >= start && match.index < end);
    if (inUrl && folder !== 'Users' && folder !== 'home') continue;
    const user = name.split(/[/\\]/)[0];
    if (!ALLOWED_USERNAMES.has(user.toLowerCase()) && !SYSTEM_HOMES.has(user)) found.push(`home path: ${path}`);
  }
  for (const [slug] of content.matchAll(SLUG)) {
    for (const [path, name] of slug.matchAll(SLUG_HOME)) {
      if (!ALLOWED_SLUG_USERNAMES.has(name.toLowerCase())) found.push(`home path: ${path}`);
    }
  }
  return found;
}

/** Temp folders, and Claude Code uids that aren’t all zeros. @param {string} content */
function tempPaths(content) {
  const found = [];
  for (const [path] of content.matchAll(TEMP_FOLDER)) found.push(`temp folder path: ${path}`);
  for (const [name, uid] of content.matchAll(CLAUDE_UID)) {
    if (!ALL_ZEROS.test(uid)) found.push(`claude uid: ${name}`);
  }
  return found;
}

/** Installation ids that aren’t all zeros. @param {string} content */
function installationIds(content) {
  const found = [];
  for (const [, id] of content.matchAll(INSTALLATION_ID)) {
    const bare = id.replace(/\s/g, '');
    if (!ALL_ZEROS.test(bare)) found.push(`installationId: ${bare}`);
  }
  return found;
}

/** Account metadata keys. @param {string} content */
function accountFields(content) {
  const keys = [...content.matchAll(ACCOUNT_FIELD)].map(([key]) => key);
  if (keys.length === 0) return [];
  return [`account field: ${keys.join(', ')}`];
}

/** API keys and tokens, named by their first characters so a report doesn’t repeat the secret. @param {string} content */
function tokens(content) {
  return [...content.matchAll(API_TOKEN)].map(([token]) => `token: ${token.slice(0, 12)}…`);
}

/** Utilization values other than 0. @param {string} content */
function utilizations(content) {
  const found = [];
  for (const [, value] of content.matchAll(UTILIZATION)) {
    if (!ZERO.test(value)) found.push(`utilization: ${value}`);
  }
  return found;
}

/** Email addresses that aren’t placeholders. @param {string} content */
function emails(content) {
  const found = [];
  for (const [email] of content.matchAll(EMAIL)) {
    if (!EXAMPLE_EMAIL.test(email) && !BOT_EMAILS.has(email) && !NOT_EMAILS.has(email)) found.push(`email: ${email}`);
  }
  return found;
}

/**
 * Checks text for leaked personal data or un-sanitized environment paths: home paths with a real user name, temp
 * folders and Claude Code uids, a real Codex installation id, account metadata, API keys and tokens, a utilization
 * other than 0, and real email addresses.
 *
 * @param {string} content
 * @param {object} [options]
 * @param {boolean} [options.exemptAccountFields=false]
 * @returns {string[]} list of violations found
 */
export function checkContentPrivacy(content, options = {}) {
  return [
    ...homePaths(content),
    ...tempPaths(content),
    ...installationIds(content),
    ...(options.exemptAccountFields ? [] : accountFields(content)),
    ...tokens(content),
    ...utilizations(content),
    ...emails(content),
  ];
}

/** A recorded Codex turn that still holds account fields, filed as #660. */
const ACCOUNT_FIELDS_660 = 'tests/fixtures/codex-app-server/resume-turn-after-failure.jsonl';

/**
 * Checks one committed file, by its path from the repository’s root, with the exemptions files have.
 *
 * @param {string} path
 * @param {string} content
 * @returns {string[]} list of violations found
 */
export function checkFilePrivacy(path, content) {
  const options = { exemptAccountFields: path === ACCOUNT_FIELDS_660 };
  const violations = checkContentPrivacy(content, options);
  if (!path.endsWith('.jsonl')) return violations;
  const allowed = ALLOWED_JOINED.get(path) ?? [];
  for (const stream of joinedDeltas(content)) {
    const found = checkContentPrivacy(stream.text, options).filter((violation) => !allowed.includes(violation));
    violations.push(...found.map((violation) => `${violation} (joined deltas from line ${stream.firstLine})`));
  }
  return violations;
}

/**
 * Placeholders a recorded stream’s joined deltas hold, by file: the prompt in permission-allow.jsonl names a made-up
 * project folder, “postbox”, where a home’s user name goes. Each entry is the exact violation it allows.
 */
const MADE_UP_HOME = ['Users', 'postbox'].join('/'); // joined at run time, so this file doesn’t hold the path itself
const ALLOWED_JOINED = new Map([['tests/fixtures/claude-code/permission-allow.jsonl', [`home path: ${MADE_UP_HOME}`]]]);

/** Whether a file is binary, as git decides it: a zero byte in its first 8,000. @param {Buffer} bytes */
export function isBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Checks each file of a tree, read by its path, whatever its size. A binary file, or one the reader can’t find, is
 * skipped and not counted.
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
    if (bytes === null || isBinary(bytes)) continue;
    checked++;
    const violations = checkFilePrivacy(path, bytes.toString('utf8'));
    if (violations.length > 0) findings.push({ path, violations });
  }
  return { checked, findings };
}
