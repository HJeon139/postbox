import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinedDeltas } from '../tools/joined-deltas.mjs';
import { checkContentPrivacy, checkFilePrivacy, checkFilesPrivacy, isBinary } from '../tools/privacy-check.mjs';
import { isSyntheticLabel, missingSyntheticFixtures, syntheticFixturePaths } from '../tools/synthetic-fixtures.mjs';

// Every example the checker must flag is built from parts here, at run time, so this file’s own text holds none and
// the tree test checks it like any other file (#508).

/** A path joined with “/”: slashed('', 'Users', 'a') is the absolute path. @param {string[]} parts */
const slashed = (...parts) => parts.join('/');

/** A Windows path joined with “\”. @param {string[]} parts */
const backslashed = (...parts) => parts.join('\\');

/** A slug, or any name joined with “-”. @param {string[]} parts */
const dashed = (...parts) => parts.join('-');

/** An email address. @param {string} name @param {string} domain */
const email = (name, domain) => `${name}@${domain}`;

/** JSON text for an object, so a key isn’t written in quotes here. @param {object} value */
const json = (value) => JSON.stringify(value);

/** That JSON escaped inside another JSON string, as a recorded line holds it. @param {object} value */
const escaped = (value) => JSON.stringify({ line: JSON.stringify(value) });

const PLAN_TYPE = ['plan', 'Type'].join(''); // an account key, built here, as one written bare before a “:” is flagged

/** A made-up installation id that isn’t all zeros. */
const ID = dashed('12345678', 'abcd', '1234', 'abcd', '123456789abc');

test('fixtures privacy checker flags path violations', () => {
  // Home paths: Unix, Windows, slugs
  for (const path of [
    slashed('', 'Users', 'melissa', 'repo'),
    slashed('', 'home', 'userbob', 'repo'),
    dashed('', 'home', 'userbob', 'repo'),
    dashed('', 'Users', 'melissa', 'repo'),
    backslashed('C:', 'Users', 'melissa', 'repo'),
    backslashed('C:', 'home', 'userbob', 'repo'),
  ]) {
    assert.ok(checkContentPrivacy(path).length > 0, `flags ${path}`);
  }

  // Temp folder paths
  for (const path of [
    slashed('', 'private', 'var', 'folders', '2c', '62', 'T', 'work'),
    slashed('', 'var', 'folders', '2c', '62', 'T', 'work'),
    dashed('', 'private', 'var', 'folders', '2c', '62', 'work'),
    dashed('', 'var', 'folders', '2c', '62', 'work'),
    slashed('', 'private', 'tmp', dashed('claude', '501'), 'work'),
    slashed('', 'tmp', dashed('claude', '501'), 'work'),
  ]) {
    assert.ok(checkContentPrivacy(path).length > 0, `flags ${path}`);
  }

  // Allowed placeholders pass cleanly
  assert.equal(checkContentPrivacy('/Users/me/repo').length, 0);
  assert.equal(checkContentPrivacy('/Users/you/repo').length, 0);
  assert.equal(checkContentPrivacy('/Users/user/repo').length, 0);
  assert.equal(checkContentPrivacy('/home/user/repo').length, 0);
  assert.equal(checkContentPrivacy('/home/you/repo').length, 0);
  assert.equal(checkContentPrivacy('-Users-me-repo').length, 0);
  assert.equal(checkContentPrivacy('C:\\Users\\me\\repo').length, 0);
  assert.equal(checkContentPrivacy('C:\\home\\user\\repo').length, 0);
  assert.equal(checkContentPrivacy('/tmp/claude/-sanitized-workspace/tasks').length, 0);
});

test('fixtures privacy checker flags identifier, account, and email violations', () => {
  // installationId (camelCase and snake_case)
  assert.ok(checkContentPrivacy(json({ installationId: ID })).length > 0, 'flags real installationId');
  assert.ok(checkContentPrivacy(json({ installation_id: ID })).length > 0, 'flags real installation_id');

  // Account metadata (camelCase and snake_case)
  for (const field of ['planType', 'authMode', 'usedPercent', 'plan_type', 'auth_mode', 'used_percent']) {
    assert.ok(checkContentPrivacy(json({ [field]: 'pro' })).length > 0, `flags ${field}`);
  }

  // Leaked email
  assert.ok(checkContentPrivacy(email('developer', 'company.org')).length > 0, 'flags real email');

  // Allowed placeholders pass cleanly
  assert.equal(checkContentPrivacy('{"installationId": "00000000-0000-0000-0000-000000000000"}').length, 0);
  assert.equal(checkContentPrivacy('{"installation_id": "00000000-0000-0000-0000-000000000000"}').length, 0);
  assert.equal(checkContentPrivacy('user@example.com').length, 0);
  assert.equal(checkContentPrivacy('noreply@anthropic.com').length, 0);
});

test('privacy checker flags a home folder inside a slug, whatever comes before it', () => {
  assert.ok(checkContentPrivacy(dashed('', 'local', 'home', 'alice', 'x')).length > 0, 'flags a home under /local');
  assert.ok(checkContentPrivacy(`projects/${dashed('', 'private', 'tmp', 'Users', 'alice', 'repo')}`).length > 0);
  assert.ok(checkContentPrivacy(dashed('-Users-me', 'home', 'alice', 'x')).length > 0, 'flags a second home folder in one slug');
  const windows = `projects/${dashed('C', '', 'Users', 'alice', 'repo')}`;
  assert.ok(checkContentPrivacy(windows).length > 0, 'flags a Windows slug, which starts with its drive');
  assert.equal(checkContentPrivacy('projects/C--Users-me-repo').length, 0);
  assert.equal(checkContentPrivacy('-local-home-me-x').length, 0);
  assert.equal(checkContentPrivacy('https://github.blog/welcome-home-agents/').length, 0, 'prose with -home- in it is not a slug');
});

test('privacy checker flags a Claude Code uid without the temp folder’s slashes', () => {
  const uid = (digits) => dashed('claude', digits);
  assert.ok(checkContentPrivacy(dashed('', 'tmp', uid('501'), 'w')).length > 0, 'flags a uid in a slug');
  assert.ok(checkContentPrivacy(uid('501')).length > 0, 'flags a bare uid');
  assert.ok(checkContentPrivacy(dashed('', 'private', 'tmp', uid('1000'), '-home-me-x')).length > 0, 'flags a Linux uid');
  assert.equal(checkContentPrivacy('-private-tmp-claude-000--Users-me-x').length, 0, 'all zeros is the scrubbed placeholder');
  assert.equal(checkContentPrivacy('claude-3-5-sonnet').length, 0, 'a model name is not a uid');
  assert.equal(checkContentPrivacy('pwd -P >| /tmp/claude-0167-cwd').length, 0, 'the shell’s cwd file has a random name, not a uid');
});

test('privacy checker flags the user placeholder in a slug, where it can be a real name’s first part', () => {
  assert.ok(checkContentPrivacy(dashed('', 'Users', 'user', 'postbox')).length > 0, 'flags it under Users');
  assert.ok(checkContentPrivacy(dashed('', 'home', 'user', 'repo')).length > 0, 'flags it under home');
  assert.equal(checkContentPrivacy('/Users/user/postbox').length, 0, 'a slashed path keeps the name whole');
  assert.equal(checkContentPrivacy('-Users-you-postbox').length, 0);
});

test('privacy checker flags Anthropic API keys and GitHub tokens at a real key’s length', () => {
  // Built here, so no file holds a string shaped like a real key.
  const tail = 'Ab3'.repeat(14);
  for (const prefix of ['sk-ant-api03-', 'ghp_', 'gho_', 'ghs_', 'github_pat_']) {
    assert.ok(checkContentPrivacy(`key ${prefix}${tail}`).length > 0, `flags ${prefix}`);
  }
  assert.equal(checkContentPrivacy('set ANTHROPIC_API_KEY=sk-ant-... first').length, 0, 'a placeholder in prose');
  assert.equal(checkContentPrivacy('ghp_xxxx and github_pat_xxxx').length, 0, 'placeholders shorter than a token');
  assert.ok(checkContentPrivacy(`key sk-ant-${'a'.repeat(21)}`).length > 0, 'flags a key just past the shortest length');
  assert.equal(checkContentPrivacy(`key sk-ant-${'a'.repeat(19)}`).length, 0, 'a key just short of it');
});

test('privacy checker flags a rate limit’s utilization unless it is 0', () => {
  assert.ok(checkContentPrivacy(json({ utilization: 0.13 })).length > 0, 'flags 0.13');
  assert.ok(checkContentPrivacy(json({ utilization: 1 })).length > 0, 'flags 1');
  assert.equal(checkContentPrivacy('{"utilization":0,"status":"allowed"}').length, 0);
  assert.equal(checkContentPrivacy('{"utilization": 0}').length, 0);
  assert.ok(checkContentPrivacy(json({ utilization: 0.05 })).length > 0, 'flags a small value that only starts with 0');
});

test('privacy checker flags keys JSON-escaped inside another string', () => {
  assert.ok(checkContentPrivacy(escaped({ utilization: 0.13 })).length > 0, 'flags an escaped utilization');
  assert.ok(checkContentPrivacy(escaped({ [PLAN_TYPE]: 'pro' })).length > 0, 'flags an escaped account field');
  assert.ok(checkContentPrivacy(escaped({ installationId: ID })).length > 0, 'flags an escaped installationId');
  assert.equal(checkContentPrivacy('{"line":"{\\"utilization\\":0}"}').length, 0);
  assert.equal(checkContentPrivacy('{"line":"{\\"installationId\\":\\"00000000-0000\\"}"}').length, 0);
});

test('privacy checker allows the placeholders, system homes and example addresses the tree holds', () => {
  assert.equal(checkContentPrivacy('/Users/someone/project').length, 0);
  assert.equal(checkContentPrivacy('/home/linuxbrew/.linuxbrew/bin').length, 0);
  assert.equal(checkContentPrivacy('for dir in "$home/.nvm/versions/node:v"').length, 0, 'a dotfolder is not a user');
  for (const address of ['user@build.example.com', 'a@zorvex-internal.example', 'git@github.com', 'a@indexer.com']) {
    assert.equal(checkContentPrivacy(`mail ${address}`).length, 0, address);
  }
  assert.equal(checkContentPrivacy("'plugins.sample@test.mcp_servers.sample.mode'").length, 0, 'a TOML key is not an address');
  assert.ok(checkContentPrivacy(email('alice', 'corp.com_backup')).length > 0, 'flags an address with a name run on after it');
  assert.ok(checkContentPrivacy(email('plugins.alice', 'corp.com_servers')).length > 0, 'flags another key shaped like it');
  assert.ok(checkContentPrivacy(slashed('', 'home', 'linuxbrewer', 'x')).length > 0, 'flags a name that starts like a system home');
  assert.ok(checkContentPrivacy(slashed('', 'Users', 'someone2', 'x')).length > 0, 'flags a name that starts like a placeholder');
  assert.ok(checkContentPrivacy(email('bob', 'example.community')).length > 0, 'flags a domain that starts like example.com');
  assert.ok(checkContentPrivacy(email('b', 'indexer.com')).length > 0, 'flags another address at a mention test’s domain');
});

/** The recorded Codex turn that once held account fields, under an exemption (#660). */
const CODEX_RESUME = 'tests/fixtures/codex-app-server/resume-turn-after-failure.jsonl';

test('privacy checker checks its own files, and the recorded Codex resume turn has no exemption (#660)', () => {
  const leak = slashed('', 'Users', 'melissa');
  for (const path of ['tools/privacy-check.mjs', 'tests/fixtures-privacy.test.mjs', 'docs/privacy-notes.md', CODEX_RESUME]) {
    assert.ok(checkFilePrivacy(path, leak).length > 0, `${path} is checked`);
  }
  assert.ok(checkFilePrivacy(CODEX_RESUME, json({ [PLAN_TYPE]: 'pro' })).length > 0, 'an account field there is flagged as anywhere');
});

test('the recorded Codex resume turn holds no account metadata (#660)', () => {
  const recorded = readFileSync(new URL(`../${CODEX_RESUME}`, import.meta.url), 'utf8');
  assert.deepEqual(checkContentPrivacy(recorded), []);
});

test('a home path pasted into this file’s own text is flagged, though its examples are not', () => {
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const path = 'tests/fixtures-privacy.test.mjs';
  assert.deepEqual(checkFilePrivacy(path, own), [], 'every example here is built at run time');
  const planted = `${own}\n// ${slashed('', 'Users', 'melissa', 'repo')}\n`;
  assert.ok(checkFilePrivacy(path, planted).length > 0, 'a pasted home path is flagged');
});

test('privacy checker flags a home folder in any case, as macOS paths are case-insensitive', () => {
  for (const path of [slashed('', 'USERS', 'x'), slashed('', 'Home', 'x'), slashed('', 'users', 'x'), dashed('', 'users', 'x', '')]) {
    assert.ok(checkContentPrivacy(path).length > 0, `flags ${path}`);
  }
  assert.equal(checkContentPrivacy('/USERS/Me/repo').length, 0, 'a placeholder in another case');
  assert.equal(checkContentPrivacy('-HOME-YOU-repo').length, 0, 'a slug’s placeholder in another case');
  assert.equal(checkContentPrivacy('mkdir "$HOME/postbox-uat"').length, 0, 'a shell variable is not a home folder');
  assert.equal(checkContentPrivacy('<https://docs.example.com/users/memory>').length, 0, 'a web page’s section');
  assert.ok(checkContentPrivacy(`https://host/${slashed('Users', 'x')}`).length > 0, 'a disk’s own case in a web address');
  assert.ok(checkContentPrivacy(`file://${slashed('', 'users', 'x')}`).length > 0, 'a file address is a disk’s path');
});

test('privacy checker reads 200 KB with no address in well under a second, whatever it repeats', () => {
  for (const unit of ['a', '.', '-', '/', '\\', '1', '_', 'a.', 'a-', '-a']) {
    const text = unit.repeat(200_000 / unit.length);
    const started = performance.now();
    checkContentPrivacy(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${JSON.stringify(unit)} took ${Math.round(elapsed)} ms`);
  }
});

test('a file is binary when its first 8,000 bytes hold a zero byte, as git decides it', () => {
  const bytes = (zeroAt) => Buffer.alloc(9000, 'a').fill(0, zeroAt, zeroAt + 1);
  assert.equal(isBinary(bytes(7999)), true, 'a zero in the last byte git reads');
  assert.equal(isBinary(bytes(8000)), false, 'a zero just past what git reads');
});

test('the tree scan checks every text file whatever its size, and skips binaries and files that are gone', () => {
  const files = new Map([
    ['docs/big.md', Buffer.from(`${'a'.repeat(200_000)}\n${slashed('', 'Users', 'melissa', 'repo')}\n`)],
    ['docs/clean.md', Buffer.from('nothing private\n')],
    ['app/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x2f, 0x55])],
  ]);
  const scan = checkFilesPrivacy([...files.keys(), 'docs/deleted.md'], (path) => files.get(path) ?? null);
  assert.equal(scan.checked, 2, 'the two text files are checked, not the binary or the deleted file');
  assert.deepEqual(
    scan.findings.map(({ path }) => path),
    ['docs/big.md'],
    'a leak past 100 KB is flagged',
  );
});

test('a first line is a synthetic label only when “SYNTHETIC” follows a comment marker', () => {
  assert.equal(isSyntheticLabel('# SYNTHETIC baseline, not recorded'), true);
  assert.equal(isSyntheticLabel('// SYNTHETIC PROTOCOL BASELINE ONLY'), true);
  assert.equal(isSyntheticLabel('{"note":"SYNTHETIC baseline"}'), false, 'a word inside a JSON line is not a label');
  assert.equal(isSyntheticLabel('{"type":"runStarted"}'), false);
});

const README = `# Test fixtures

## Synthetic fixtures

Why each is allowed.
- \`tests/fixtures/a.jsonl\`: the first.
- \`tests/fixtures/b.jsonl\`: the second.

## Another section
- \`tests/fixtures/not-listed.jsonl\`: in another section.
`;

test('the fixtures README’s synthetic fixtures are the paths its “Synthetic fixtures” section lists', () => {
  assert.deepEqual(syntheticFixturePaths(README), ['tests/fixtures/a.jsonl', 'tests/fixtures/b.jsonl']);
  assert.throws(() => syntheticFixturePaths('# Test fixtures\n'), /no “Synthetic fixtures” section/);
});

test('a synthetic fixture the README lists but the tree doesn’t hold is reported missing', () => {
  assert.deepEqual(
    missingSyntheticFixtures(README, (path) => path === 'tests/fixtures/a.jsonl'),
    ['tests/fixtures/b.jsonl'],
  );
  assert.equal(missingSyntheticFixtures(README, () => true).length, 0, 'nothing is missing when every listed file is there');
});

/** A recorded Claude Code stream line: one delta of a message’s content block. */
const deltaLine = (messageId, index, delta) => json({ type: 'stream_event', event: { type: 'content_block_delta', index, delta }, api_message_id: messageId });

/** A home slug cut across three tool-input deltas, as denials.jsonl once held one (#742). */
function splitSlugStream() {
  const slug = dashed('', 'Users', 'janedoe', 'postbox');
  const parts = [slug.slice(0, 4), slug.slice(4, 11), slug.slice(11)];
  return parts.map((part) => deltaLine('msg_a', 1, { type: 'input_json_delta', partial_json: part })).join('\n');
}

test('a value split across a stream’s deltas is found once the deltas are joined', () => {
  const stream = splitSlugStream();
  assert.deepEqual(checkContentPrivacy(stream), [], 'no single line holds the slug, so a line-by-line scan misses it');
  const violations = checkFilePrivacy('tests/fixtures/x.jsonl', stream);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^home path: .*\(joined deltas from line 1\)$/);
});

test('joined deltas are checked only in JSONL files, and each stream is joined on its own', () => {
  assert.deepEqual(checkFilePrivacy('tests/fixtures/x.json', splitSlugStream()), []);
  // The same three parts in three different streams, by message, by block and by delta type, never form the slug.
  const slug = dashed('', 'Users', 'janedoe', 'postbox');
  const apart = [
    deltaLine('msg_a', 1, { type: 'input_json_delta', partial_json: slug.slice(0, 4) }),
    deltaLine('msg_b', 1, { type: 'input_json_delta', partial_json: slug.slice(4, 11) }),
    deltaLine('msg_a', 2, { type: 'input_json_delta', partial_json: slug.slice(11) }),
  ].join('\n');
  assert.deepEqual(checkFilePrivacy('tests/fixtures/x.jsonl', apart), []);
});

test('a stream’s text and thinking deltas are joined too, and lines that aren’t stream events are skipped', () => {
  const home = slashed('', 'home', 'janedoe', 'x');
  const lines = [
    'not json, but it says delta',
    json({ delta: 'a bare string' }),
    deltaLine('msg_a', 0, { type: 'text_delta', text: home.slice(0, 6) }),
    deltaLine('msg_a', 0, { type: 'text_delta', text: home.slice(6) }),
    deltaLine('msg_a', 3, { type: 'thinking_delta', thinking: home.slice(0, 3) }),
    deltaLine('msg_a', 3, { type: 'thinking_delta', thinking: home.slice(3) }),
  ];
  assert.deepEqual(
    joinedDeltas(lines.join('\n')).map(({ firstLine, text }) => [firstLine, text]),
    [
      [3, home],
      [5, home],
    ],
  );
});
