// The privacy checker for committed text, kept apart from its test so a CI tool can reuse it (#508).

/** Placeholder user names a slashed home path may use. */
const ALLOWED_USERNAMES = new Set(['me', 'you', 'user']);

/**
 * Placeholder user names a slug may use. A slug turns every “/” and “.” into “-”, so “-Users-user-name-” can’t tell
 * “/Users/user/name” from a real account named “user.name” or “user-name”, and “user” is the placeholder that most
 * often starts a real name. A slashed path keeps the name whole, so “/Users/user/” stays allowed there.
 */
const ALLOWED_SLUG_USERNAMES = new Set(['me', 'you']);

// A home path, Unix or Windows (“/Users/x”, “/home/x”, “C:\Users\x”, “\home\x”), and the user name after it.
const SLASHED_HOME = /(?:[A-Za-z]:[/\\]+|(?<=^|[^A-Za-z0-9_-]))[/\\]*(?:Users|home)[/\\]+([a-zA-Z0-9._-]+)/g;

// A Claude Code project slug: a path with each “/” and “.” turned into “-”, such as “-local-home-alice-repo”. It starts
// with a “-” that follows no slug character, so “welcome-home-agents” in prose isn’t one.
const SLUG = /(?<![A-Za-z0-9_.-])-[A-Za-z0-9_.-]+/g;

// A home folder inside a slug, and the user name after it, up to the next “-”.
const SLUG_HOME = /-(?:Users|home)-([A-Za-z0-9_.]+)/g;

// macOS temp folders (slashed or slugged), and Claude Code’s “/tmp/claude-<uid>/” folder.
const TEMP_FOLDER = /(?:\/(?:private\/)?var\/folders\/|-+(?:private-)?var-folders-|\/(?:private\/)?tmp\/claude-\d+\/)[a-zA-Z0-9._-]*/g;

// Claude Code’s temp folder uid without its slashes, such as “claude-501” or the slug “-tmp-claude-501-w”. A uid has
// three digits or more (macOS starts at 501, Linux at 1000), so a model name such as “claude-3-5” isn’t one.
// “claude-0167-cwd” is the random name of the file a shell writes its folder to, not a uid.
const CLAUDE_UID = /(?<![A-Za-z0-9])claude-(\d{3,})(?![A-Za-z0-9]|-cwd\b)/g;

// A scrubbed id: all zeros, with or without dashes.
const ALL_ZEROS = /^0+(?:-0+)*$/;

// Codex’s installationId or installation_id, and its value.
const INSTALLATION_ID = /"installation(?:Id|_id)"\s*:\s*"([^"]+)"/g;

// Account metadata keys (camelCase and snake_case).
const ACCOUNT_FIELD = /"(planType|authMode|usedPercent|plan_type|auth_mode|used_percent)"/g;

// Anthropic API keys and GitHub tokens, at the lengths server/telemetry-secrets.mjs matches, so a placeholder such as
// “sk-ant-...” or “ghp_xxxx” in prose isn’t one.
const API_TOKEN = /\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}/g;

// A rate limit’s “utilization”, how much of the account’s limit it used, and its value. Only 0 says nothing.
const UTILIZATION = /"utilization"\s*:\s*([^,}\]\s]+)/g;

// The value a scrubbed utilization holds.
const ZERO = /^0(?:\.0+)?$/;

// An email address.
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// A placeholder address, at example.com, the domain reserved for examples.
const EXAMPLE_EMAIL = /@(?:host\.)?example\.com$/;

/** Addresses that belong to no person: the agents’ commit authors. */
const BOT_EMAILS = new Set(['noreply@anthropic.com', 'noreply@openai.com']);

/** Home paths, slashed or in a slug, whose user name isn’t a placeholder. @param {string} content */
function homePaths(content) {
  const found = [];
  for (const [path, name] of content.matchAll(SLASHED_HOME)) {
    if (!ALLOWED_USERNAMES.has(name.split(/[/\\]/)[0])) found.push(`home path: ${path}`);
  }
  for (const [slug] of content.matchAll(SLUG)) {
    for (const [path, name] of slug.matchAll(SLUG_HOME)) {
      if (!ALLOWED_SLUG_USERNAMES.has(name)) found.push(`home path: ${path}`);
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
    if (!EXAMPLE_EMAIL.test(email) && !BOT_EMAILS.has(email)) found.push(`email: ${email}`);
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
