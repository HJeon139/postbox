// The privacy checker for committed text, kept apart from its test so a CI tool can reuse it (#508).

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
