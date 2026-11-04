import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { checkContentPrivacy } from './privacy-check.mjs';

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (!entry.name.startsWith('.')) files.push(full);
  }
  return files;
}

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');

/**
 * Checks a fixture file for leaked personal data or un-sanitized environment paths.
 *
 * @param {string} filePath
 * @returns {string[]} list of violations found
 */
export function checkFixturePrivacy(filePath) {
  const rel = relative(FIXTURES_DIR, filePath);
  // Pre-existing issue on main (#660), filed separately
  const isPreExisting660 = rel === 'codex-app-server/resume-turn-after-failure.jsonl';

  const content = readFileSync(filePath, 'utf8');
  return checkContentPrivacy(content, { exemptAccountFields: isPreExisting660 });
}

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
});

test('privacy checker flags a rate limit’s utilization unless it is 0', () => {
  assert.ok(checkContentPrivacy('{"utilization":0.13}').length > 0, 'flags 0.13');
  assert.ok(checkContentPrivacy('{"utilization": 1}').length > 0, 'flags 1');
  assert.equal(checkContentPrivacy('{"utilization":0,"status":"allowed"}').length, 0);
  assert.equal(checkContentPrivacy('{"utilization": 0}').length, 0);
});

test('fixtures privacy: recorded fixtures contain no leaked home paths, accounts, or identifiers', () => {
  const allFiles = walk(FIXTURES_DIR);
  const failures = [];

  for (const file of allFiles) {
    const violations = checkFixturePrivacy(file);
    if (violations.length > 0) {
      const rel = relative(FIXTURES_DIR, file);
      failures.push({ file: rel, violations });
    }
  }

  assert.equal(
    failures.length,
    0,
    `Found private data in ${failures.length} fixture file(s):\n${failures.map((f) => `  - ${f.file}: ${f.violations.join('; ')}`).join('\n')}`,
  );
});
