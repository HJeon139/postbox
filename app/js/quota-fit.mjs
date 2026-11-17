// How the quota line’s bars fit its one row (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). Decided from measured widths, not fixed cutoffs: the line’s width, and each label’s and percent’s width in
// the line’s font. Every bar keeps its percent whole; to make room, they give way in one order, all together:
// 0 everything; 1 the track goes; 2 short backend names; 3 the percent alone, the full label in its title and for
// screen readers. Two bars that would read the same get the shortest start of their hosts’ names that tells them apart;
// a level where nothing can is passed over.

/** Short backend names, for a narrow line. */
const SHORT = { 'claude-code': 'Claude', 'agent-sdk': 'SDK', codex: 'Codex', 'kiro-cli': 'Kiro', 'antigravity-cli': 'agy', mock: 'Mock' };
/** The gap between bars, and inside one, the track and the space after it (workbench.css, .quota-line and .quota-bar). */
export const LINE_GAP = 12;
const TRACK = 40 + 6;
/** Room for a canvas measure and the drawn text to differ by. */
const SLACK = 2;

/** A host name’s first n characters, without the hyphen, dot or underscore they may end on. @param {string} host @param {number} n */
const startOf = (host, n) => host.slice(0, n).replace(/[-_.\s]+$/, '');

/**
 * The names bars show at one level, each distinct: bars that share a name get the shortest start of their hosts’ names
 * that tells them apart (“@workstation-1” and “@workstation-2”, “@a” and “@b”). Null where nothing does: two hosts
 * of one name. @param {{ backend: string, full: string, host: string | null }[]} bars @param {boolean} short
 * @returns {string[] | null}
 */
export function namesAt(bars, short) {
  const base = bars.map((b) => (short ? (SHORT[b.backend] ?? b.full) : b.full));
  const names = [...base];
  for (const name of new Set(base)) {
    const group = base.flatMap((x, i) => (x === name ? [i] : []));
    if (group.length < 2) continue;
    const hosts = group.map((i) => bars[i].host ?? '');
    const longest = Math.max(...hosts.map((x) => x.length));
    const cut = Array.from({ length: longest }, (_, n) => n + 1).find((n) => new Set(hosts.map((x) => startOf(x, n))).size === hosts.length);
    if (!cut) return null;
    for (const i of group) if (bars[i].host) names[i] = `${name} @${startOf(/** @type {string} */ (bars[i].host), cut)}`;
  }
  return names;
}

/**
 * The level the bars fit at, and what each shows: its name (empty at the last level) and whether the track shows.
 * @param {{ backend: string, full: string, host: string | null, pct: string }[]} bars  pct: the percent as drawn
 * @param {number} width  the line’s width @param {(text: string) => number} measure  a text’s width in the line’s font
 * @returns {{ level: number, names: string[], track: boolean }}
 */
export function fitBars(bars, width, measure) {
  const each = (width - LINE_GAP * (bars.length - 1)) / Math.max(1, bars.length);
  const levels = /** @type {const} */ ([
    [false, true],
    [false, false],
    [true, false],
  ]);
  for (const [level, [short, track]] of levels.entries()) {
    const names = namesAt(bars, short);
    if (!names) continue;
    const fits = bars.every((b, i) => (track ? TRACK : 0) + measure(`${names[i]} `) + measure(b.pct) + SLACK <= each);
    if (fits) return { level, names, track };
  }
  return { level: 3, names: bars.map(() => ''), track: false };
}
