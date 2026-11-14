// What an agent app’s code applies, read for the font rule (#1322, shared/app-fonts.mjs): its stylesheets, the
// attributes of its real tags, and its scripts split into code and strings. Text between tags, HTML, CSS and script
// comments, and what a script only holds in a string are left out, so an app that shows CSS isn’t read as applying it.
//
// validateBlock runs this on the server, synchronously, on up to LIMITS.appCode characters, so it reads in one
// forward pass, with indexOf and character loops and no pattern that can backtrack: an unclosed tag, quote or
// comment ends the scan at the end of the code rather than restarting it (#1322’s review measured a regex taking
// 4.8 s on 280 KB).

/** Whether a character is HTML’s whitespace. @param {string | undefined} c */
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
/** Whether a character can start a tag’s name. @param {string | undefined} c */
const startsName = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/**
 * One tag’s name and attributes, from just after its `<`, and where it ends: after its `>`, or the code’s end when a
 * quote or the tag never closes. @param {string} code @param {number} start
 * @returns {{ name: string, attrs: { name: string, value: string }[], end: number }}
 */
function readTag(code, start) {
  const n = code.length;
  let i = start;
  while (i < n && !isSpace(code[i]) && code[i] !== '>' && code[i] !== '/') i++;
  const name = code.slice(start, i);
  const attrs = [];
  while (i < n) {
    while (i < n && (isSpace(code[i]) || code[i] === '/')) i++;
    if (i >= n) break;
    if (code[i] === '>') return { name, attrs, end: i + 1 };
    const from = i;
    while (i < n && !isSpace(code[i]) && code[i] !== '=' && code[i] !== '>' && code[i] !== '/') i++;
    const attr = code.slice(from, i);
    let j = i;
    while (j < n && isSpace(code[j])) j++;
    if (code[j] !== '=') {
      if (attr) attrs.push({ name: attr, value: '' });
      if (i === from) i++;
      continue;
    }
    j++;
    while (j < n && isSpace(code[j])) j++;
    const quote = code[j];
    if (quote === '"' || quote === "'") {
      const close = code.indexOf(quote, j + 1);
      if (close === -1) return { name, attrs, end: n };
      attrs.push({ name: attr, value: code.slice(j + 1, close) });
      i = close + 1;
    } else {
      const from2 = j;
      while (j < n && !isSpace(code[j]) && code[j] !== '>') j++;
      attrs.push({ name: attr, value: code.slice(from2, j) });
      i = j;
    }
  }
  return { name, attrs, end: n };
}

/** Each raw-text element’s closing tag, in any case, searched from where its body starts. */
const CLOSERS = { style: /<\/style\s*>/gi, script: /<\/script\s*>/gi };

/**
 * An app’s HTML, read once: the bodies of its <style> and <script> elements, and its tags’ attributes. An unclosed
 * comment, element or tag runs to the end of the code, as a browser reads it. @param {string} code
 * @returns {{ styles: string[], scripts: string[], attributes: { name: string, value: string }[] }}
 */
export function htmlParts(code) {
  /** @type {string[]} */ const styles = [];
  /** @type {string[]} */ const scripts = [];
  /** @type {{ name: string, value: string }[]} */ const attributes = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const lt = code.indexOf('<', i);
    if (lt === -1) break;
    if (code.startsWith('<!--', lt)) {
      const end = code.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    // Text that isn’t a tag (a closing tag, a doctype, a bare <) holds no font.
    if (!startsName(code[lt + 1])) {
      i = lt + 1;
      continue;
    }
    const tag = readTag(code, lt + 1);
    attributes.push(...tag.attrs);
    i = tag.end;
    const raw = tag.name.toLowerCase();
    if (raw !== 'style' && raw !== 'script') continue;
    const closer = CLOSERS[raw];
    closer.lastIndex = i;
    const m = closer.exec(code);
    (raw === 'style' ? styles : scripts).push(code.slice(i, m ? m.index : n));
    i = m ? m.index + m[0].length : n;
  }
  return { styles, scripts, attributes };
}

/** CSS with its comments taken out; an unclosed one runs to the end. @param {string} css */
export function withoutCssComments(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('/*', i);
    if (open === -1) return out + css.slice(i);
    out += css.slice(i, open);
    const close = css.indexOf('*/', open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
  return out;
}

/**
 * A script as code and strings, comments taken out: `code` pieces between the strings, each string’s text, in
 * order. A template literal is one string, its ${…} kept as text. A quote or comment left open runs to the end of
 * its line (a quote) or the script (a comment or template). @param {string} js
 * @returns {{ kind: 'code' | 'string', text: string }[]}
 */
export function scriptTokens(js) {
  /** @type {{ kind: 'code' | 'string', text: string }[]} */
  const out = [];
  let code = '';
  const n = js.length;
  let i = 0;
  while (i < n) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') {
      const end = js.indexOf('\n', i + 2);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      const end = js.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c !== '"' && c !== "'" && c !== '`') {
      code += c;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && js[j] !== c && !(c !== '`' && js[j] === '\n')) j += js[j] === '\\' ? 2 : 1;
    if (code) out.push({ kind: 'code', text: code });
    code = '';
    out.push({ kind: 'string', text: js.slice(i + 1, Math.min(j, n)) });
    i = j + 1;
  }
  if (code) out.push({ kind: 'code', text: code });
  return out;
}
