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
