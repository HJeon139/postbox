// How the quota line’s bars fit its one row (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). Decided from measured widths, not fixed cutoffs: the line’s width, and each label’s and percent’s width in
// the line’s font. Every bar keeps its percent whole; to make room, they give way in one order, all together:
// 0 everything; 1 the track goes; 2 short backend names; 3 the percent alone, the full label in its title and for
// screen readers. Two bars that would read the same get their host’s name, shortened, after theirs.

/** Short backend names, for a narrow line. */
const SHORT = { 'claude-code': 'Claude', 'agent-sdk': 'SDK', codex: 'Codex', 'kiro-cli': 'Kiro', 'antigravity-cli': 'agy', mock: 'Mock' };
/** The gap between bars, and inside one, the track and the space after it (workbench.css, .quota-line and .quota-bar). */
export const LINE_GAP = 12;
const TRACK = 40 + 6;
/** Room for a canvas measure and the drawn text to differ by. */
const SLACK = 2;

/**
 * The names bars show at one level, each made distinct: a name two bars share gets its host, shortened, after it.
 * @param {{ backend: string, full: string, host: string | null }[]} bars @param {boolean} short
 */
function namesAt(bars, short) {
  const base = bars.map((b) => (short ? (SHORT[b.backend] ?? b.full) : b.full));
  return base.map((name, i) => {
    const host = bars[i].host;
    const shared = base.filter((x) => x === name).length > 1;
    return shared && host ? `${name} @${host.slice(0, 6)}` : name;
  });
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
    const fits = bars.every((b, i) => (track ? TRACK : 0) + measure(`${names[i]} `) + measure(b.pct) + SLACK <= each);
    if (fits) return { level, names, track };
  }
  return { level: 3, names: bars.map(() => ''), track: false };
}
