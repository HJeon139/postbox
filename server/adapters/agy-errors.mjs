// Why an Antigravity turn failed, in words the person reads: when its quota resets, and its exit code’s reason.

import { cleanSaid } from '../../shared/text-parts.mjs';

/**
 * When a quota resets, from agy’s “Resets in 155h28m23s” (#396, as the “Agent research” room recorded it), or null.
 * @param {unknown} error @param {number} now
 */
export function resetIn(error, now) {
  const m = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(String(error ?? ''));
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return now + ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Why a turn failed, from its exit code, when the stream didn’t say. agy logs to a file, so stderr is short. */
export function exitError(code, stderr = '') {
  // Cleaned as a CLI’s words are (#1938).
  const why = cleanSaid(
    String(stderr)
      .split('\n')
      .filter((l) => l.trim() && !/^warning:/i.test(l))
      .slice(-3)
      .join(' '),
    400,
  );
  return `Antigravity exited with code ${code}${why ? `: ${why}` : ''}.`;
}
