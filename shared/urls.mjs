// URL checks shared by the Markdown renderer and the catalog validator.

const DEFAULT_SCHEMES = ['https:', 'http:', 'mailto:'];

/**
 * True when a URL is absolute, uses an allowed scheme and, if origins are given, an allowed origin.
 * Relative URLs, javascript:, data: and anything that fails to parse are rejected.
 * @param {string} url
 * @param {{ schemes?: string[], origins?: string[] }} [opts]
 */
export function isSafeUrl(url, { schemes = DEFAULT_SCHEMES, origins } = {}) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a URL are exactly what this rejects
  if (typeof url !== 'string' || url.length > 2048 || /[\u0000-\u001f\s]/.test(url)) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!schemes.includes(u.protocol)) return false;
  if (origins && u.protocol !== 'mailto:' && !origins.includes(u.origin)) return false;
  if (u.username || u.password) return false;
  return true;
}

/** Plain http to this computer, the one place an image may be http: Postbox’s own media. */
export const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
/**
 * A URL of Postbox’s own, which names 127.0.0.1 or localhost, moved to the page’s origin. Postbox answers at both, and
 * its media URLs name the one it started with, which a page opened at the other doesn’t count as 'self' (#180). Any
 * other URL is unchanged.
 * @param {string} src @param {string} page  the page’s origin, such as http://localhost:4191
 */
export function onPageOrigin(src, page) {
  const u = new URL(src);
  const p = new URL(page);
  const ours = LOOPBACK.has(u.hostname) && LOOPBACK.has(p.hostname) && u.port === p.port && u.protocol === p.protocol;
  return ours ? `${p.origin}${u.pathname}${u.search}${u.hash}` : src;
}
