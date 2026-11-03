import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

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

const ALLOWED_USERNAMES = new Set(['me', 'you', 'user']);

/**
 * Checks text content for leaked personal data or un-sanitized environment paths.
 *
 * Rules:
 * 1. Home paths: /Users/, \Users\, C:\Users\, /home/, \home\, C:\home\, -Users-, -home-
 *    must use allowed placeholders (me, you, user) as the entire username path segment.
 * 2. Temp-folder paths: /private/var/folders/, /var/folders/, -private-var-folders-,
 *    -var-folders-, /private/tmp/claude-<uid>/, /tmp/claude-<uid>/ are forbidden.
 * 3. Codex installationId / installation_id: must be all zeros (00000000-0000-0000-0000-000000000000).
 * 4. Account metadata: planType, authMode, usedPercent, plan_type, auth_mode, used_percent must not appear.
 * 5. Email addresses: real email addresses must not appear (example.com, test domains, and bot emails permitted).
 *
 * @param {string} content
 * @param {object} [options]
 * @param {boolean} [options.exemptAccountFields=false]
 * @returns {string[]} list of violations found
 */
export function checkContentPrivacy(content, options = {}) {
  const violations = [];

  // 1. Home paths: match prefix followed by the username segment
  const homePattern = /(?:[A-Za-z]:[/\\]+|(?<=^|[^A-Za-z0-9_-]))(?:[/\\]*(?:Users|home)[/\\]+|-(?:Users|home)-)([a-zA-Z0-9._-]+)/g;
  let hm;
  while ((hm = homePattern.exec(content)) !== null) {
    const fullMatch = hm[0];
    const rawUser = hm[1];
    const isSlug = fullMatch.startsWith('-Users-') || fullMatch.startsWith('-home-');
    const userSegment = isSlug ? rawUser.split('-')[0] : rawUser.split(/[/\\]/)[0];
    if (!ALLOWED_USERNAMES.has(userSegment)) {
      violations.push(`home path: ${fullMatch}`);
    }
  }

  // 2. Temp folder paths: macOS var/folders (slashed or slugged) and claude-<uid> directory
  const tempMatches = content.match(/(?:\/(?:private\/)?var\/folders\/|-+(?:private-)?var-folders-|\/(?:private\/)?tmp\/claude-\d+\/)[a-zA-Z0-9._-]*/g);
  if (tempMatches) {
    for (const tm of tempMatches) {
      violations.push(`temp folder path: ${tm}`);
    }
  }

  // 3. Codex installationId / installation_id
  const installMatches = content.match(/"installation(?:Id|_id)"\s*:\s*"([^"]+)"/g);
  if (installMatches) {
    for (const m of installMatches) {
      const id = m.split(':')[1].replace(/["\s]/g, '');
      if (!/^0+(?:-0+)*$/.test(id)) {
        violations.push(`installationId: ${id}`);
      }
    }
  }

  // 4. Account metadata (camelCase and snake_case)
  if (!options.exemptAccountFields) {
    const acctMatches = content.match(/"(planType|authMode|usedPercent|plan_type|auth_mode|used_percent)"/g);
    if (acctMatches) {
      violations.push(`account field: ${acctMatches.join(', ')}`);
    }
  }

  // 5. Email addresses
  const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emailMatches) {
    for (const em of emailMatches) {
      if (em.endsWith('@example.com') || em.endsWith('@host.example.com') || em === 'noreply@anthropic.com' || em === 'noreply@openai.com') {
        continue;
      }
      violations.push(`email: ${em}`);
    }
  }

  return violations;
}

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
  assert.equal(checkContentPrivacy('-home-user-repo').length, 0);
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
