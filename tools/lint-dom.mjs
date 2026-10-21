// lint-dom: the safe-DOM rules from the dynamic UI contract. HTML is only parsed where a comment says
// where it comes from (the Markdown renderer, which escapes everything, or Postbox’s own templates), and
// nothing an agent sends is used as code, a style or an attribute name. See designs/architecture.md.
//
//   node tools/lint-dom.mjs

import { fileURLToPath } from 'node:url';
import { allowed, codeOnly, files, read, report, scan } from './lint-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const RULES = [
  {
    re: /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/,
    message: 'Sets innerHTML. Build nodes with h(), or say where the HTML comes from with “lint-allow dom: <source>”.',
  },
  { re: /\binsertAdjacentHTML\s*\(/, message: 'Parses HTML with insertAdjacentHTML. Build nodes with h() instead.' },
  { re: /\bdocument\.write(?:ln)?\s*\(/, message: 'document.write is never needed.' },
  { re: /(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(/, message: 'Runs a string as code.' },
  { re: /\bsetAttribute(?:NS)?\s*\(\s*(?!['"`])/, message: 'An attribute name that isn’t a literal. Agent data must never name an attribute.' },
  { re: /\.style\s*\[/, message: 'A style property chosen at run time. Agent data must never name a style.' },
  { re: /\.style\.cssText\s*=|\.setAttribute\(\s*['"]style['"]/, message: 'Sets a whole style string. Set named properties, or use a class.' },
  { re: /\.style\.setProperty\(/, unless: /\.style\.setProperty\(\s*['"`]--/, message: 'Sets a style property that isn’t a literal custom property.' },
  { re: /\.srcdoc\s*=/, message: 'Agent apps load from /sandbox/app/, never srcdoc.' },
];

export function checkJs(text, file) {
  const lines = text.split('\n');
  const tokens = scan(text);
  const code = codeOnly(text, tokens).split('\n');
  const findings = [];
  code.forEach((l, n) => {
    // Rules look at code only; `unless` looks at the real line, for rules about what a string literal holds.
    for (const r of RULES)
      if (r.re.test(l) && !r.unless?.test(lines[n]) && !allowed(lines, n + 1, 'dom')) findings.push({ file, line: n + 1, message: r.message });
  });
  // A link that opens a new tab must not hand the new page a reference to this one.
  for (const t of tokens) {
    if ((t.kind === 'string' || t.kind === 'template') && /target=["']?_blank/.test(t.text) && !/noopener/.test(t.text) && !allowed(lines, t.line, 'dom')) {
      findings.push({ file, line: t.line, message: 'A target="_blank" link without rel="noopener".' });
    }
  }
  code.forEach((l, n) => {
    if (
      /\.target\s*=/.test(l) &&
      /_blank/.test(lines[n]) &&
      !/noopener/.test(lines.slice(Math.max(0, n - 2), n + 3).join('\n')) &&
      !allowed(lines, n + 1, 'dom')
    ) {
      findings.push({ file, line: n + 1, message: 'A link opened in a new tab without rel = "noopener".' });
    }
  });
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = [];
  for (const f of files(ROOT, ['app', 'shared'], ['.js', '.mjs'], ['app/kit/vendor'])) findings.push(...checkJs(read(ROOT, f), f));
  report('lint-dom', findings);
}
