// Checks WCAG 2.1 contrast for the Workbench tokens in both themes.
// Usage: node tools/contrast.mjs [path/to/workbench.css]
import { readFileSync } from 'node:fs';

const css = readFileSync(process.argv[2] ?? new URL('../mockups/workbench.css', import.meta.url), 'utf8');

function block(selector) {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw new Error(`No block for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  // Translucent tokens (washes such as --mark) are kept as [r, g, b, a] and composited when checked.
  for (const m of body.matchAll(/--([\w-]+):\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/g)) out[m[1]] = [+m[2], +m[3], +m[4], +m[5]];
  return out;
}

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const over = ([r, g, b, a], hex) => {
  const base = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${[r, g, b]
    .map((c, i) =>
      Math.round(c * a + base[i] * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum] — 4.5 for text, 3 for non-text (borders, icons, focus rings).
const checks = [
  ['text', 'bg', 4.5],
  ['text', 'panel', 4.5],
  ['text', 'sunk', 4.5],
  ['text', 'chip', 4.5],
  ['dim', 'bg', 4.5],
  ['dim', 'panel', 4.5],
  ['dim', 'sunk', 4.5],
  ['dim', 'chip', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'panel', 4.5],
  // A chosen chip’s label and an on toggle’s knob, and a selected segment on a sunk field (#181).
  ['accent', 'chip', 4.5],
  ['accent', 'sunk', 4.5],
  ['on-ink', 'on', 4.5],
  ['good', 'bg', 4.5],
  ['good', 'panel', 4.5],
  ['alert', 'bg', 3],
  ['alert', 'panel', 3],
  ['alert-ink', 'bg', 4.5],
  ['alert-ink', 'panel', 4.5],
  ['st-think', 'panel', 4.5],
  ['st-gen', 'panel', 4.5],
  ['st-tool', 'panel', 4.5],
  ['st-idle', 'panel', 4.5],
  ['st-think', 'bg', 4.5],
  ['st-gen', 'bg', 4.5],
  ['st-tool', 'bg', 4.5],
  ['stage-text', 'stage-bg', 4.5],
  ['stage-text', 'stage-panel', 4.5],
  ['stage-text', 'stage-chip', 4.5],
  ['stage-dim', 'stage-bg', 4.5],
  ['stage-dim', 'stage-panel', 4.5],
  ['stage-dim', 'stage-sunk', 4.5],
  ['stage-dim', 'stage-chip', 4.5],
  ['accent', 'stage-bg', 4.5],
  ['accent', 'stage-panel', 4.5],
  ['accent', 'stage-chip', 4.5],
  ['stage-label', 'stage-panel', 4.5],
  ['stage-edge', 'bg', 3],
  ['stage-edge', 'stage-panel', 3],
  ['line-strong', 'bg', 3],
  ['line-strong', 'panel', 3],
  ['line-strong', 'sunk', 3],
  ['line-strong', 'chip', 3],
  ['stage-line-strong', 'stage-bg', 3],
  ['stage-line-strong', 'stage-panel', 3],
  ['stage-line-strong', 'stage-sunk', 3],
  ['stage-line-strong', 'stage-chip', 3],
  ['syn-kw', 'sunk', 4.5],
  ['syn-str', 'sunk', 4.5],
  ['syn-num', 'sunk', 4.5],
  ['syn-fn', 'sunk', 4.5],
  ['syn-com', 'sunk', 4.5],
  // Review lines: line numbers and text on the marked, added and removed backgrounds.
  ['dim', 'mark', 4.5],
  ['dim', 'diff-add', 4.5],
  ['dim', 'diff-del', 4.5],
  ['text', 'mark', 4.5],
  ['text', 'diff-add', 4.5],
  ['text', 'diff-del', 4.5],
  ['good', 'diff-add', 3],
  ['alert-ink', 'diff-del', 3],
];

let failed = 0;
for (const [name, sel] of [
  ['dark', ':root'],
  ['light', ':root[data-theme="light"]'],
]) {
  const t = block(sel);
  console.log(`\n${name}`);
  for (const [fg, bg, min] of checks) {
    if (!t[fg] || !t[bg]) {
      console.log(`  missing --${fg} or --${bg}`);
      failed++;
      continue;
    }
    // A translucent background is checked over both surfaces it sits on, and the worse one counts.
    const r = Array.isArray(t[bg]) ? Math.min(ratio(t[fg], over(t[bg], t.bg)), ratio(t[fg], over(t[bg], t.panel))) : ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? 'pass' : 'FAIL'}  --${fg} on --${bg}  ${r.toFixed(2)} (needs ${min})`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks pass');
process.exit(failed ? 1 : 0);
