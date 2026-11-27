// How the quota line’s bars fit its one row (#442; designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). Decided from measured widths, not fixed cutoffs: the line’s width, and each label’s and percent’s width in
// the line’s font. Every bar keeps its percent whole; to make room, they give way in one order, all together:
// 0 everything; 1 short backend names; 2 the percent alone, the full label in its title and for screen readers. The
// track lies above the words and fills the bar’s part, so it never costs them width (#1463). Two bars that would read
// the same get the shortest start of their hosts’ names that tells them apart; a level where nothing can is passed over.

import { cutText } from '/shared/text-parts.mjs';

/** Short backend names, for a narrow line. */
const SHORT = { 'claude-code': 'Claude', codex: 'Codex', 'kiro-cli': 'Kiro', 'antigravity-cli': 'agy', mock: 'Mock' };
/** The gap between bars (workbench.css, .quota-line). */
export const LINE_GAP = 12;
/** Room for a canvas measure and the drawn text to differ by. */
const SLACK = 2;

/** A host name’s first n characters, without the hyphen, dot or underscore they may end on. @param {string} host @param {number} n */
const startOf = (host, n) => cutText(host, n).replace(/[-_.\s]+$/, '');

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
 * The level the bars fit at, and the name each shows (empty at the last level).
 * @param {{ backend: string, full: string, host: string | null, pct: string }[]} bars  pct: the percent as drawn
 * @param {number} width  the line’s width @param {(text: string) => number} measure  a text’s width in the line’s font
 * @returns {{ level: number, names: string[] }}
 */
export function fitBars(bars, width, measure) {
  const each = (width - LINE_GAP * (bars.length - 1)) / Math.max(1, bars.length);
  for (const [level, short] of [false, true].entries()) {
    const names = namesAt(bars, short);
    if (!names) continue;
    if (bars.every((b, i) => measure(`${names[i]} `) + measure(b.pct) + SLACK <= each)) return { level, names };
  }
  return { level: 2, names: bars.map(() => '') };
}
