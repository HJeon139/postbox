import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkContentPrivacy, checkFilePrivacy, isBinary, isSyntheticLabel, missingSyntheticFixtures, syntheticFixturePaths } from '../tools/privacy-check.mjs';

test('fixtures privacy checker flags path violations', () => {
  // Home paths: Unix, Windows, slugs
  assert.ok(checkContentPrivacy('/Users/melissa/repo').length > 0, 'flags /Users/melissa');
  assert.ok(checkContentPrivacy('/home/userbob/repo').length > 0, 'flags /home/userbob');
  assert.ok(checkContentPrivacy('-home-userbob-repo').length > 0, 'flags -home-userbob-');
  assert.ok(checkContentPrivacy('-Users-melissa-repo').length > 0, 'flags -Users-melissa-');
  assert.ok(checkContentPrivacy('C:\\Users\\melissa\\repo').length > 0, 'flags Windows C:\\Users\\melissa');
  assert.ok(checkContentPrivacy('C:\\home\\userbob\\repo').length > 0, 'flags Windows C:\\home\\userbob');

  // Temp folder paths
  assert.ok(checkContentPrivacy('/private/var/folders/2c/62/T/work').length > 0, 'flags /private/var/folders/');
  assert.ok(checkContentPrivacy('/var/folders/2c/62/T/work').length > 0, 'flags /var/folders/');
  assert.ok(checkContentPrivacy('-private-var-folders-2c-62-work').length > 0, 'flags -private-var-folders-');
  assert.ok(checkContentPrivacy('-var-folders-2c-62-work').length > 0, 'flags -var-folders-');
  assert.ok(checkContentPrivacy('/private/tmp/claude-501/work').length > 0, 'flags /private/tmp/claude-501/');
  assert.ok(checkContentPrivacy('/tmp/claude-501/work').length > 0, 'flags /tmp/claude-501/');

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
  assert.ok(checkContentPrivacy('{"installationId": "12345678-abcd-1234-abcd-123456789abc"}').length > 0, 'flags real installationId');
  assert.ok(checkContentPrivacy('{"installation_id": "12345678-abcd-1234-abcd-123456789abc"}').length > 0, 'flags real installation_id');

  // Account metadata (camelCase and snake_case)
  assert.ok(checkContentPrivacy('{"planType": "pro"}').length > 0, 'flags planType');
  assert.ok(checkContentPrivacy('{"authMode": "oauth"}').length > 0, 'flags authMode');
  assert.ok(checkContentPrivacy('{"usedPercent": 50}').length > 0, 'flags usedPercent');
  assert.ok(checkContentPrivacy('{"plan_type": "pro"}').length > 0, 'flags plan_type');
  assert.ok(checkContentPrivacy('{"auth_mode": "oauth"}').length > 0, 'flags auth_mode');
  assert.ok(checkContentPrivacy('{"used_percent": 50}').length > 0, 'flags used_percent');

  // Leaked email
  assert.ok(checkContentPrivacy('developer@company.org').length > 0, 'flags real email');

  // Allowed placeholders pass cleanly
  assert.equal(checkContentPrivacy('{"installationId": "00000000-0000-0000-0000-000000000000"}').length, 0);
  assert.equal(checkContentPrivacy('{"installation_id": "00000000-0000-0000-0000-000000000000"}').length, 0);
  assert.equal(checkContentPrivacy('user@example.com').length, 0);
  assert.equal(checkContentPrivacy('noreply@anthropic.com').length, 0);
});

test('privacy checker flags a home folder inside a slug, whatever comes before it', () => {
  assert.ok(checkContentPrivacy('-local-home-alice-x').length > 0, 'flags -local-home-alice-');
  assert.ok(checkContentPrivacy('projects/-private-tmp-Users-alice-repo').length > 0, 'flags -private-tmp-Users-alice-');
  assert.ok(checkContentPrivacy('-Users-me-home-alice-x').length > 0, 'flags a second home folder in one slug');
  assert.ok(checkContentPrivacy('projects/C--Users-alice-repo').length > 0, 'flags a Windows slug, which starts with its drive');
  assert.equal(checkContentPrivacy('projects/C--Users-me-repo').length, 0);
  assert.equal(checkContentPrivacy('-local-home-me-x').length, 0);
  assert.equal(checkContentPrivacy('https://github.blog/welcome-home-agents/').length, 0, 'prose with -home- in it is not a slug');
});

test('privacy checker flags a Claude Code uid without the temp folder’s slashes', () => {
  assert.ok(checkContentPrivacy('-tmp-claude-501-w').length > 0, 'flags -tmp-claude-501-');
  assert.ok(checkContentPrivacy('claude-501').length > 0, 'flags claude-501');
  assert.ok(checkContentPrivacy('-private-tmp-claude-1000--home-me-x').length > 0, 'flags claude-1000');
  assert.equal(checkContentPrivacy('-private-tmp-claude-000--Users-me-x').length, 0, 'all zeros is the scrubbed placeholder');
  assert.equal(checkContentPrivacy('claude-3-5-sonnet').length, 0, 'a model name is not a uid');
  assert.equal(checkContentPrivacy('pwd -P >| /tmp/claude-0167-cwd').length, 0, 'the shell’s cwd file has a random name, not a uid');
});

test('privacy checker flags the user placeholder in a slug, where it can be a real name’s first part', () => {
  assert.ok(checkContentPrivacy('-Users-user-postbox').length > 0, 'flags -Users-user-');
  assert.ok(checkContentPrivacy('-home-user-repo').length > 0, 'flags -home-user-');
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
  assert.ok(checkContentPrivacy('{"utilization":0.13}').length > 0, 'flags 0.13');
  assert.ok(checkContentPrivacy('{"utilization": 1}').length > 0, 'flags 1');
  assert.equal(checkContentPrivacy('{"utilization":0,"status":"allowed"}').length, 0);
  assert.equal(checkContentPrivacy('{"utilization": 0}').length, 0);
  assert.ok(checkContentPrivacy('{"utilization":0.05}').length > 0, 'flags a small value that only starts with 0');
});

test('privacy checker flags keys JSON-escaped inside another string', () => {
  assert.ok(checkContentPrivacy('{"line":"{\\"utilization\\":0.13}"}').length > 0, 'flags an escaped utilization');
  assert.ok(checkContentPrivacy('{"line":"{\\"planType\\":\\"pro\\"}"}').length > 0, 'flags an escaped account field');
  const id = '12345678-abcd-1234-abcd-123456789abc';
  assert.ok(checkContentPrivacy(`{"line":"{\\"installationId\\":\\"${id}\\"}"}`).length > 0, 'flags an escaped installationId');
  assert.equal(checkContentPrivacy('{"line":"{\\"utilization\\":0}"}').length, 0);
  assert.equal(checkContentPrivacy('{"line":"{\\"installationId\\":\\"00000000-0000\\"}"}').length, 0);
});

test('privacy checker allows the placeholders, system homes and example addresses the tree holds', () => {
  assert.equal(checkContentPrivacy('/Users/someone/project').length, 0);
  assert.equal(checkContentPrivacy('/home/linuxbrew/.linuxbrew/bin').length, 0);
  assert.equal(checkContentPrivacy('for dir in "$home/.nvm/versions/node:v"').length, 0, 'a dotfolder is not a user');
  for (const email of ['user@build.example.com', 'a@zorvex-internal.example', 'git@github.com', 'a@indexer.com']) {
    assert.equal(checkContentPrivacy(`mail ${email}`).length, 0, email);
  }
  assert.equal(checkContentPrivacy("'plugins.sample@test.mcp_servers.sample.mode'").length, 0, 'a TOML key is not an address');
  assert.ok(checkContentPrivacy('alice@corp.com_backup').length > 0, 'flags an address with a name run on after it');
  assert.ok(checkContentPrivacy('plugins.alice@corp.com_servers').length > 0, 'flags any other key shaped like the TOML one');
  assert.ok(checkContentPrivacy('/home/linuxbrewer/x').length > 0, 'flags a name that only starts like a system home');
  assert.ok(checkContentPrivacy('/Users/someone2/x').length > 0, 'flags a name that only starts like a placeholder');
  assert.ok(checkContentPrivacy('bob@example.community').length > 0, 'flags a domain that only starts like example.com');
  assert.ok(checkContentPrivacy('b@indexer.com').length > 0, 'flags another address at a mention test’s domain');
});

test('privacy checker exempts its own files, and only account fields in the #660 fixture', () => {
  assert.deepEqual(checkFilePrivacy('tools/privacy-check.mjs', '/Users/melissa'), []);
  assert.ok(checkFilePrivacy('tests/other.test.mjs', '/Users/melissa').length > 0, 'another file is checked');
  const fixture = 'tests/fixtures/codex-app-server/resume-turn-after-failure.jsonl';
  assert.deepEqual(checkFilePrivacy(fixture, '{"planType": "pro"}'), []);
  assert.ok(checkFilePrivacy(fixture, '/Users/melissa').length > 0, 'the #660 fixture still has its paths checked');
});

test('a file is binary when its first 8,000 bytes hold a zero byte, as git decides it', () => {
  const bytes = (zeroAt) => Buffer.alloc(9000, 'a').fill(0, zeroAt, zeroAt + 1);
  assert.equal(isBinary(bytes(7999)), true, 'a zero in the last byte git reads');
  assert.equal(isBinary(bytes(8000)), false, 'a zero just past what git reads');
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
