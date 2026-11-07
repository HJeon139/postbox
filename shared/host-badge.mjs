// A host’s badge: the short name the agents list shows for it in place of its SSH destination, which can fill the
// row. The person sets one in the host’s settings; until they do, it’s the first part of the machine’s name. The full
// destination stays in the badge’s tooltip and the agent’s panel. The server checks a name with checkShortName, and
// the page draws the badge with badgeOf.

/** The most characters a host’s short name has, so its badge stays compact. */
export const SHORT_MAX = 8;

const CONTROL = /\p{Cc}/u;

/**
 * A short name the person typed: trimmed, at most SHORT_MAX characters, with no control characters. An empty one
 * clears it, so the badge goes back to the one made from the destination.
 * @param {unknown} v @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function checkShortName(v) {
  if (typeof v !== 'string') return { ok: false, error: 'A host’s short name is text.' };
  const s = v.trim();
  if (CONTROL.test(s)) return { ok: false, error: 'A short name can’t contain control characters, such as a new line.' };
  const n = Array.from(s).length;
  if (n > SHORT_MAX) return { ok: false, error: `That short name is ${n} characters; the most is ${SHORT_MAX}.` };
  return { ok: true, value: s };
}

/**
 * The badge for a host: its short name, or the first part of its machine’s name cut to SHORT_MAX characters
 * (user@dev-box.corp.example.com is “dev-box”). An IP address keeps its end, where addresses on one network differ.
 * @param {{ name?: string, short?: string } | null | undefined} host
 */
export function badgeOf(host) {
  if (host?.short) return host.short;
  const machine = String(host?.name ?? '')
    .replace(/^.*@/, '')
    .replace(/^\[(.*)\]$/, '$1');
  // An IPv4 or IPv6 address: its end. A name: its first label, from its start.
  if (/^[\d.]+$|:/.test(machine)) return Array.from(machine).slice(-SHORT_MAX).join('');
  return Array.from(machine.split('.')[0] || machine)
    .slice(0, SHORT_MAX)
    .join('');
}
