// lint-tokens: no raw colors outside the token blocks. Colors are defined once, on :root in workbench.css
// (and its dark and stage variants), and everything else uses var(--token). See designs/architecture.md.
//
//   node tools/lint-tokens.mjs

import { fileURLToPath } from 'node:url';
import { allowed, files, read, report, scan } from './lint-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;
// Named colors as a CSS value, not as words in prose.
const NAMED = /(?:^|[:\s(,])(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|pink|brown|cyan|magenta)\s*(?:;|!|$|\))/;

/** Raw colors in CSS outside a :root block. */
export function checkCss(text, file) {
  const findings = [];
  const lines = text.split('\n');
  const stack = []; // selectors of the open blocks
  let selector = '';
  let comment = false;
  lines.forEach((raw, n) => {
    let s = raw;
    // Drop comments, which may span lines.
    if (comment) {
      const end = s.indexOf('*/');
      if (end < 0) return;
      s = s.slice(end + 2);
      comment = false;
    }
    s = s.replace(/\/\*.*?\*\//g, '');
    const open = s.indexOf('/*');
    if (open >= 0) {
      s = s.slice(0, open);
      comment = true;
    }
    for (const part of s.split(/(?=[{}])|(?<=[{}])/)) {
      if (part === '{') {
        stack.push(selector.trim());
        selector = '';
      } else if (part === '}') {
        stack.pop();
        selector = '';
      } else {
        const inToken = stack.some((sel) => /^:root\b/.test(sel));
        const decl = stack.length > 0 && !/^@/.test(stack.at(-1) ?? '');
        if (decl && !inToken && (COLOR.test(part) || NAMED.test(part)) && !allowed(lines, n + 1, 'tokens')) {
          findings.push({ file, line: n + 1, message: `Raw color outside the token blocks: “${part.trim().slice(0, 80)}”. Use a var(--token).` });
        }
        if (!part.includes(';')) selector += ` ${part}`;
        else selector = part.slice(part.lastIndexOf(';') + 1);
      }
    }
  });
  return findings;
}

/** Raw colors in JavaScript strings and templates. */
export function checkJs(text, file) {
  const lines = text.split('\n');
  return scan(text)
    .filter((t) => (t.kind === 'string' || t.kind === 'template') && COLOR.test(t.text))
    .filter((t) => !allowed(lines, t.line, 'tokens'))
    .map((t) => ({
      file,
      line: t.line,
      message: `Raw color in a string: “${t.text.match(COLOR)?.[0]}”. Use var(--token) or read the token with getComputedStyle.`,
    }));
}

/** Raw colors in HTML outside a <style> :root block. */
export function checkHtml(text, file) {
  const lines = text.split('\n');
  const findings = [];
  lines.forEach((l, n) => {
    if (COLOR.test(l) && !allowed(lines, n + 1, 'tokens')) findings.push({ file, line: n + 1, message: 'Raw color in HTML. Use a class and a var(--token).' });
  });
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = [];
  for (const f of files(ROOT, ['app'], ['.css'], ['app/kit/vendor'])) findings.push(...checkCss(read(ROOT, f), f));
  for (const f of files(ROOT, ['app/index.html'], ['.html'])) findings.push(...checkHtml(read(ROOT, f), f));
  for (const f of files(ROOT, ['app', 'server/sandbox.mjs', 'server/mock'], ['.js', '.mjs'], ['app/kit/vendor'])) findings.push(...checkJs(read(ROOT, f), f));
  report('lint-tokens', findings);
}
