// Inline Markdown: code spans, math, links, citations, bare links, emphasis, glossary terms and @mentions inside
// one line of text. Moved out of shared/markdown.mjs, which renders the blocks and calls inline for their text. All
// text is escaped, as there.

import { mathAt } from './math.mjs';
import { isSafeUrl } from './urls.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// ── Inline ──────────────────────────────────────────────────────────────────────────────

export function inline(s, ctx) {
  let out = '',
    buf = '',
    i = 0;
  // Code spans bind tighter than emphasis, so **`x`** is bold: each span waits in the text run as a
  // U+0000 and goes back in, in order, once the run's emphasis is applied.
  const codes = [];
  const flush = () => {
    out += textRun(buf, ctx).replace(/\0/g, () => codes.shift());
    buf = '';
  };
  while (i < s.length) {
    const c = s[i];
    const math = c === '$' || c === '\\' ? mathAt(s, i) : null;
    if (math) {
      flush();
      out += `<span class="md-math"${math.display ? ' data-display="true"' : ''}>${escapeHtml(math.tex)}</span>`;
      i = math.end;
      continue;
    }
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!|$~>@]/.test(s[i + 1] ?? '')) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > -1) {
        codes.push(`<code>${escapeHtml(s.slice(i + run.length, end).replace(/^ (.*) $/, '$1'))}</code>`);
        buf += '\0';
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    if (c === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > -1) {
        const label = s.slice(i + 1, close);
        if (s[close + 1] === '(') {
          const end = matchParen(s, close + 1);
          if (end > -1) {
            const target = s.slice(close + 2, end).trim();
            flush();
            out += link(label, target, ctx);
            i = end + 1;
            continue;
          }
        } else if (/^\d{1,3}$/.test(label) && ctx.citations && +label >= 1 && +label <= ctx.citations) {
          flush();
          out += `<a class="cite" href="#${escapeHtml(ctx.citeId ?? 'src')}-${+label}" data-cite="${+label}" aria-label="Source ${+label}">${+label}</a>`;
          i = close + 1;
          continue;
        }
      }
    }

    // Streaming text can stop right after “https://”, so the full match may not be there yet.
    const bare = (c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(s[i - 1])) ? s.slice(i).match(/^https?:\/\/[^\s<>"]+/i) : null;
    if (bare) {
      const url = bare[0].replace(/[.,;:!?)\]'”’]+$/, '');
      if (isSafeUrl(url)) {
        flush();
        out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        i += url.length;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

function matchParen(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) return j;
  }
  return -1;
}

function link(label, target, ctx) {
  const text = inline(label, { ...ctx, citations: 0 });
  const term = target.match(/^term:([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})$/);
  if (term) return `<span class="term" tabindex="0" data-term="${escapeHtml(term[1])}">${text}</span>`;
  if (isSafeUrl(target)) return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  // An unsafe or relative link keeps its text and drops the address.
  return text;
}

// Escapes, then applies emphasis, then glossary terms and @mentions to text outside the tags it made.
function textRun(raw, ctx) {
  if (!raw) return '';
  const s = escapeHtml(raw)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/\*(?=[^\s*])([^*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  if (!ctx.glossaryRe && !ctx.mentionRe) return s;
  return s
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) return part;
      if (ctx.mentionRe) part = part.replace(ctx.mentionRe, (_m, pre, handle) => `${pre}<span class="mention">@${handle}</span>`);
      if (ctx.glossaryRe) {
        part = part
          .split(/(<[^>]+>)/)
          .map((p) =>
            p.startsWith('<')
              ? p
              : p.replace(ctx.glossaryRe.re, (m) => {
                  const key = ctx.glossaryRe.keys.get(m.toLowerCase());
                  return `<span class="term" tabindex="0" data-term="${escapeHtml(key)}">${m}</span>`;
                }),
          )
          .join('');
      }
      return part;
    })
    .join('');
}

export function glossaryRegex(glossary) {
  const entries = (glossary ?? []).filter((g) => g?.term && g?.key);
  if (!entries.length) return null;
  const keys = new Map(entries.map((g) => [escapeHtml(g.term).toLowerCase(), g.key]));
  const alts = [...keys.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { re: new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'gi'), keys };
}

export function mentionRegex(handles) {
  const hs = (handles ?? []).filter((h) => /^[A-Za-z0-9_-]+$/.test(h));
  if (!hs.length) return null;
  return new RegExp(`(^|[^\\w@])@(${hs.join('|')})(?![\\w-])`, 'g');
}
