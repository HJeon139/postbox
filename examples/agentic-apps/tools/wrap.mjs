// Wraps an agent app in a stub Postbox host so headless Chrome can render it, and appends a text-overlap check
// that writes its findings into <pre id="__report">.
// Usage: node wrap.mjs in.html out.html [--state JSON] [--theme light|dark]
// --state seeds restoreState and ready.state, so a middle step or a Predict step can be rendered.
// Run Chrome with --force-prefers-reduced-motion to check the reduced-motion path.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , input, output, ...rest] = process.argv;
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const state = opt("--state", "null"), theme = opt("--theme", "light");
JSON.parse(state);
// Postbox's app folder in this checkout; set POSTBOX_APP to use another one.
const PB = process.env.POSTBOX_APP ?? new URL('../../../app', import.meta.url).pathname.replace(/\/$/, '');
const html = readFileSync(input, 'utf8');
const head = `<link rel="stylesheet" href="file://${PB}/workbench.css">
<script src="file://${PB}/kit/vendor/d3/d3.min.js"></script>
<script>
window.__errors = []; addEventListener("error", e => __errors.push(String(e.message))); addEventListener("unhandledrejection", e => __errors.push(String(e.reason)));
window.postbox = { ready: Promise.resolve({ state: ${state} }), load: async () => window.d3,
  saveState(){}, restoreState: async () => (${state}), send(){}, on(){} };
document.documentElement.classList.add('stage');
document.head.insertAdjacentHTML('beforeend', '<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>'); // headless virtual time doesn’t finish CSS transitions
document.documentElement.dataset.theme = '${theme}';
</script>`;
const check = `<script>
const __measure = () => {
  const out = [];
  const name = (e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const shown = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0; };
  // 1. Text that spills out of its own box.
  for (const e of document.body.querySelectorAll('*')) {
    if (e.closest('svg') || e.id === '__report' || !shown(e)) continue;
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(e);
    if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && cs.overflowX === 'visible')
      out.push('text-overflow: “' + name(e) + '” is ' + e.scrollWidth + ' px wide in a ' + e.clientWidth + ' px box');
  }
  // 2. Text that overlaps other text.
  const runs = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (!n.textContent.trim() || !p || p.id === '__report' || p.closest('#__report') || !shown(p)) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) runs.push({ n, b });
  }
  const seen = new Set();
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], c = runs[j]; if (a.n === c.n) continue;
    const x = Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left);
    const y = Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top);
    if (x > 2 && y > 2) { const k = a.n.textContent.slice(0, 20) + '|' + c.n.textContent.slice(0, 20); if (seen.has(k)) continue; seen.add(k);
      out.push('text-overlap: “' + a.n.textContent.trim().slice(0, 30) + '” overlaps “' + c.n.textContent.trim().slice(0, 30) + '” by ' + Math.round(x) + '×' + Math.round(y) + ' px'); }
  }
  for (const e of window.__errors) out.push('script-error: ' + e);
  const sw = document.documentElement.scrollWidth;
  if (sw > innerWidth + 1) out.push('page-overflow: ' + sw + ' px content in ' + innerWidth + ' px');
  return out;
};
// Measure twice, 1.5 s apart, and keep only problems seen both times: d3 transitions run on timers that
// CSS can’t switch off, so a single measurement can catch labels mid-move.
setTimeout(() => { const first = __measure(); setTimeout(() => { const out = __measure().filter((x) => first.includes(x));
  const pre = document.createElement('pre'); pre.id = '__report'; pre.textContent = 'REPORT@' + innerWidth + '\\n' + (out.join('\\n') || 'clean');
  document.body.appendChild(pre);
}, 1500); }, 1500);
</script>`;
const wrapped = html.replace('<head>', '<head>' + head).replace('</body>', check + '</body>');
writeFileSync(output, wrapped);
