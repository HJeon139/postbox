// Shared pieces for Postbox’s own lint scripts (lint-tokens, lint-dom, lint-copy).
// See designs/architecture.md, “Code quality”.
//
// scan() is a small JavaScript tokenizer: it finds string literals, the text parts of template literals,
// comments and regular expressions, with their line numbers. It doesn’t parse; it only has to tell
// those apart from code, which is what the lint rules look at.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** @typedef {{ kind: 'string'|'template'|'comment'|'regex', text: string, line: number, start: number, end: number }} Token */

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await', 'else', 'do']);

/**
 * @param {string} src
 * @returns {Token[]}
 */
export function scan(src) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  let line = 1;
  let prev = ''; // the last significant code character, or a word
  const braces = []; // for each open `${`, how many plain braces are open inside it
  const at = (k) => src[i + k] ?? '';
  const take = () => {
    const c = src[i++];
    if (c === '\n') line++;
    return c;
  };

  const template = () => {
    // Called just after the opening backtick, or after the `}` that closes a `${`.
    let text = '';
    const start = line;
    const from = i;
    while (i < src.length) {
      const c = take();
      if (c === '\\') {
        text += c + take();
        continue;
      }
      if (c === '`') {
        out.push({ kind: 'template', text, line: start, start: from, end: i - 1 });
        prev = 'x';
        return;
      }
      if (c === '$' && at(0) === '{') {
        take();
        out.push({ kind: 'template', text, line: start, start: from, end: i - 2 });
        braces.push(0);
        prev = '(';
        return;
      }
      text += c;
    }
  };

  while (i < src.length) {
    const c = at(0);
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      take();
      continue;
    }
    if (c === '/' && at(1) === '/') {
      const start = line;
      const from = i;
      let text = '';
      while (i < src.length && at(0) !== '\n') text += take();
      out.push({ kind: 'comment', text, line: start, start: from, end: i });
      continue;
    }
    if (c === '/' && at(1) === '*') {
      const start = line;
      const from = i;
      let text = '';
      while (i < src.length && !(at(0) === '*' && at(1) === '/')) text += take();
      i += 2;
      out.push({ kind: 'comment', text, line: start, start: from, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      take();
      const from = i;
      let text = '';
      while (i < src.length && at(0) !== c && at(0) !== '\n') text += at(0) === '\\' ? take() + take() : take();
      out.push({ kind: 'string', text, line: start, start: from, end: i });
      take();
      prev = 'x';
      continue;
    }
    if (c === '`') {
      take();
      template();
      continue;
    }
    if (c === '/') {
      const division = /[\w$)\]}]/.test(prev) && !REGEX_AFTER_WORD.has(prev);
      if (!division) {
        const start = line;
        take();
        const from = i;
        let text = '';
        let cls = false;
        while (i < src.length && at(0) !== '\n') {
          const d = take();
          if (d === '\\') {
            text += d + take();
            continue;
          }
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          text += d;
        }
        const end = i - 1;
        while (/[a-z]/.test(at(0))) take();
        out.push({ kind: 'regex', text, line: start, start: from, end });
        prev = 'x';
        continue;
      }
    }
    if (braces.length && c === '{') braces[braces.length - 1]++;
    if (braces.length && c === '}') {
      if (braces[braces.length - 1] === 0) {
        braces.pop();
        take();
        template();
        continue;
      }
      braces[braces.length - 1]--;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let word = '';
      while (/[\w$]/.test(at(0))) word += take();
      prev = word;
      continue;
    }
    prev = take();
  }
  return out;
}

/**
 * The source with every string, template text, comment and regex blanked to spaces (newlines kept),
 * so a rule that looks for code only ever sees code. Quote marks stay, so `f('x')` reads as `f(' ')`.
 */
export function codeOnly(src, tokens = scan(src)) {
  const chars = src.split('');
  for (const t of tokens) for (let k = t.start; k < t.end; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

/**
 * Whether a finding on this line is allowed by a `lint-allow <rule>: <reason>` comment on it or the line above.
 * The reason is required, so every exception says why.
 */
export function allowed(lines, line, rule) {
  const re = new RegExp(`lint-allow ${rule}:\\s*\\S`);
  if (re.test(lines[line - 1] ?? '') || re.test(lines[line - 2] ?? '')) return true;
  // A whole file can opt out of one rule, with a reason, in its first 20 lines.
  const file = new RegExp(`lint-allow-file ${rule}:\\s*\\S`);
  return lines.slice(0, 20).some((l) => file.test(l));
}

/** Files under the given folders with one of the extensions, as paths relative to root. */
export function files(root, dirs, exts, skip = []) {
  const found = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(root, p);
      if (n === 'node_modules' || skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => n.endsWith(e))) found.push(rel);
    }
  };
  for (const d of dirs) {
    const p = join(root, d);
    if (statSync(p, { throwIfNoEntry: false })?.isFile()) found.push(d);
    else if (statSync(p, { throwIfNoEntry: false })) walk(p);
  }
  return found.sort();
}

/** Reads a file for the lint rules. */
export const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

/** Prints findings like a compiler does and sets the exit code. */
export function report(name, findings) {
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.message}`);
  if (findings.length) {
    console.log(
      `\n${name}: ${findings.length} problem${findings.length === 1 ? '' : 's'}. Fix them, or add “lint-allow <rule>: <reason>” where the exception is deliberate.`,
    );
    process.exitCode = 1;
  } else console.log(`${name}: no problems.`);
}
