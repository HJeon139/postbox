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
  return out;
}

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum] — 4.5 for text, 3 for non-text (borders, icons, focus rings).
const checks = [
  ['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'sunk', 4.5], ['text', 'chip', 4.5],
  ['dim', 'bg', 4.5], ['dim', 'panel', 4.5], ['dim', 'sunk', 4.5], ['dim', 'chip', 4.5],
  ['accent', 'bg', 4.5], ['accent', 'panel', 4.5], ['on-ink', 'on', 4.5],
  ['good', 'bg', 4.5], ['good', 'panel', 4.5],
  ['alert', 'bg', 3], ['alert', 'panel', 3], ['alert-ink', 'bg', 4.5], ['alert-ink', 'panel', 4.5],
  ['st-think', 'panel', 4.5], ['st-gen', 'panel', 4.5], ['st-tool', 'panel', 4.5], ['st-idle', 'panel', 4.5],
  ['st-think', 'bg', 4.5], ['st-gen', 'bg', 4.5], ['st-tool', 'bg', 4.5],
  ['stage-text', 'stage-bg', 4.5], ['stage-text', 'stage-panel', 4.5], ['stage-text', 'stage-chip', 4.5],
  ['stage-dim', 'stage-bg', 4.5], ['stage-dim', 'stage-panel', 4.5], ['stage-dim', 'stage-sunk', 4.5], ['stage-dim', 'stage-chip', 4.5],
  ['accent', 'stage-bg', 4.5], ['accent', 'stage-panel', 4.5], ['stage-label', 'stage-panel', 4.5],
  ['stage-edge', 'bg', 3], ['stage-edge', 'stage-panel', 3],
  ['syn-kw', 'sunk', 4.5], ['syn-str', 'sunk', 4.5], ['syn-num', 'sunk', 4.5], ['syn-fn', 'sunk', 4.5], ['syn-com', 'sunk', 4.5],
];

let failed = 0;
for (const [name, sel] of [['dark', ':root'], ['light', ':root[data-theme="light"]']]) {
  const t = block(sel);
  console.log(`\n${name}`);
  for (const [fg, bg, min] of checks) {
    if (!t[fg] || !t[bg]) { console.log(`  missing --${fg} or --${bg}`); failed++; continue; }
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? 'pass' : 'FAIL'}  --${fg} on --${bg}  ${r.toFixed(2)} (needs ${min})`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks pass');
process.exit(failed ? 1 : 0);
