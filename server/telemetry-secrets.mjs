// Secrets out of the classifier’s input (designs/telemetry-persona.md, R3): before the call, anything Postbox’s secret
// patterns or its entropy test match becomes [secret], so the classifier never sees a key it could encode. This trims
// what goes in; the gate (shared/telemetry.mjs) still checks every byte that comes out.

export const SECRET = '[secret]';

/** Known key shapes: cloud, forge and model-provider keys, tokens, private keys, and a secret-named setting’s value. */
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /((?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

/** Bits per character of a string’s letters. */
function entropy(s) {
  const n = new Map();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

/**
 * A long run of key-like characters as random as a key, what no pattern names yet: letters with several digits, or with
 * both cases and a digit. A name such as parse_settings_v2 isn’t one.
 */
const RANDOM = /[A-Za-z0-9+/=_-]{20,}/g;
const random = (s) => /[A-Za-z]/.test(s) && ((s.match(/\d/g) ?? []).length >= 3 || (/[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s))) && entropy(s) >= 3.5;

/**
 * The text with its secrets replaced by [secret].
 * @param {string} text
 */
export function trimSecrets(text) {
  let out = String(text ?? '');
  for (const p of PATTERNS) out = out.replace(p, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}${SECRET}` : SECRET));
  return out.replace(RANDOM, (m) => (random(m) ? SECRET : m));
}
