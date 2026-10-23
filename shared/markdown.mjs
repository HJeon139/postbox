// A small, safe Markdown renderer. All text is escaped; raw HTML is shown as text, never rendered.
// The output contains only tags and attributes this file writes. Agent text only ever becomes element
// content or an escaped attribute value, never an attribute name, a tag name or a style.
//
// Supported: paragraphs (a single newline is a line break), # headings, - and 1. lists (nested by
// indentation), > quotes, ``` fences, ```mermaid diagrams, $$ math blocks (or $$…$$ on one line), $inline math$,
// LaTeX’s \[display\] and \(inline\) math, pipe tables,
// ---, `code`, **bold**, *italic*, ~~strikethrough~~, [links](https://…), bare https:// links,
// citation markers [1], term links [label](term:key), glossary auto-links and @mentions.
// While a reply is streaming, an unclosed fence is drawn as if it were closed.
//
// The one exception to "raw HTML is text": <details> starting a line, with an optional <summary>…</summary>
// right after it, closed by its </details>, folds its Markdown away (agents use it to hide an exercise's
// answer). The tags must be exactly these, with no attributes; anything else, or an unclosed tag, is text.

import { displayMath, mathAt } from './math.mjs';
import { isSafeUrl } from './urls.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// The block rules, shared with the review renderer's line grouping (review-lines.mjs).
export const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
export { MATH } from './math.mjs';
export const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
export const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
export const QUOTE = /^ {0,3}>\s?(.*)$/;
export const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
export const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** Whether a line closes a fence opened with `marker` (such as ``` or ~~~~). */
export const closesFence = (marker, line) => new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(line);

/**
 * @param {string} src
 * @param {{
 *   streaming?: boolean,
 *   citations?: number,          // how many sources the message has; [n] becomes a marker when 1 ≤ n ≤ citations
 *   citeId?: string,             // prefix for source anchors: #<citeId>-<n>
 *   glossary?: { key: string, term: string }[],
 *   mentions?: string[],         // handles without the @
 *   folds?: boolean,             // false shows <details> as text, as a review does
 * }} [opts]
 * @returns {string} HTML
 */
export function renderMarkdown(src, opts = {}) {
  const ctx = { ...opts, glossaryRe: glossaryRegex(opts.glossary), mentionRe: mentionRegex(opts.mentions) };
  return blocks(
    // U+0000 stands in for a code span inside a run of text (see inline), so the text can't contain it.
    String(src ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\0/g, '\uFFFD')
      .split('\n'),
    ctx,
  );
}

function blocks(lines, ctx) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l.trim(), ctx)).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const marker = fence[1],
        lang = fence[2].toLowerCase();
      const body = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closesFence(marker, lines[i])) {
          closed = true;
          break;
        }
        body.push(lines[i]);
      }
      const code = escapeHtml(body.join('\n'));
      if (lang === 'mermaid' && closed) out.push(`<figure class="md-mermaid"><pre><code>${code}</code></pre></figure>`);
      else out.push(`<pre class="md-code"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${code}</code></pre>`);
      continue;
    }

    const display = displayMath(lines, i);
    if (display) {
      flush();
      out.push(`<div class="md-math" data-display="true">${escapeHtml(display.tex)}</div>`);
      i = display.end;
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      flush();
      const level = Math.min(5, Math.max(3, h[1].length + 1));
      out.push(`<h${level}>${inline(h[2], ctx)}</h${level}>`);
      continue;
    }

    const fold = ctx.folds !== false && line.trimStart().startsWith('<details>') ? details(lines, i) : null;
    if (fold) {
      flush();
      const summary = fold.summary === null ? '' : `<summary>${inline(fold.summary.trim(), ctx)}</summary>`;
      out.push(`<details>${summary}${blocks(fold.body, ctx)}</details>`);
      // Text after </details> on its line is read as a line of its own.
      if (fold.after.trim()) {
        out.push(blocks([fold.after, ...lines.slice(fold.end + 1)], ctx));
        break;
      }
      i = fold.end;
      continue;
    }

    // "---", "***" and "- - -" are rules; "- item" is a list item, which RULE doesn't match.
    if (RULE.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].match(QUOTE)[1]);
      i--;
      out.push(`<blockquote>${blocks(body, ctx)}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flush();
      const body = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const next = lines[i + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next))) {
            body.push('');
            continue;
          }
          break;
        }
        // A fold (an exercise's answer under its question, say) belongs to the item, blank lines and all.
        const fold = ctx.folds !== false && body.length && l.trimStart().startsWith('<details>') ? details(lines, i) : null;
        if (fold) {
          for (; i <= fold.end; i++) body.push(!lines[i].trim() ? '' : /^\s{2,}/.test(lines[i]) ? lines[i] : `  ${lines[i].trimStart()}`);
          i--;
          continue;
        }
        if (LIST_ITEM.test(l) || /^\s{2,}\S/.test(l) || body.length === 0) {
          body.push(l);
          continue;
        }
        // A plain line right after an item continues that item (lazy continuation).
        body.push('  ' + l.trim());
      }
      i--;
      out.push(list(body, ctx));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const rows = [line];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(lines[i]);
      i--;
      out.push(table(rows, lines, ctx));
      continue;
    }

    para.push(line);
  }
  flush();
  return out.join('');
}

/**
 * Finds the <details> that starts lines[i] and its matching </details>, counting nested ones and skipping
 * fences. Returns null when it isn't exactly that shape, so the caller shows it as text.
 * @param {string[]} lines
 * @param {number} i
 * @returns {{ summary: string | null, body: string[], after: string, end: number } | null}
 */
function details(lines, i) {
  let first = lines[i].trimStart().slice('<details>'.length);
  /** @type {string | null} */
  let summary = null;
  // The summary may follow on the same line or start the next one.
  let from = i;
  if (!first.trim() && lines[i + 1]?.trimStart().startsWith('<summary')) {
    from = i + 1;
    first = lines[i + 1];
  }
  if (first.trimStart().startsWith('<summary')) {
    // A summary with attributes (or a stray "<summaryx") leaves the whole block as text.
    if (!first.trimStart().startsWith('<summary>')) return null;
    const rest = first.trimStart().slice('<summary>'.length);
    const close = rest.indexOf('</summary>');
    if (close < 0) return null;
    summary = rest.slice(0, close);
    first = rest.slice(close + '</summary>'.length);
  }
  const body = [first];
  let depth = 1;
  /** @type {string | null} */
  let fence = null;
  for (let j = from; j < lines.length; j++) {
    const line = j === from ? first : lines[j];
    if (j > from) body.push(line);
    if (fence) {
      if (closesFence(fence, line)) fence = null;
      continue;
    }
    const opens = line.match(FENCE);
    if (opens && j > from) {
      fence = opens[1];
      continue;
    }
    // A tag inside `code` is text, so it neither opens nor closes.
    const masked = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const tag of masked.matchAll(/<(\/?)details>/g)) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) {
        body[body.length - 1] = line.slice(0, tag.index);
        return { summary, body, after: line.slice((tag.index ?? 0) + tag[0].length), end: j };
      }
    }
  }
  return null;
}

function list(lines, ctx) {
  const base = lines[0].match(LIST_ITEM)[1].length;
  const ordered = /\d/.test(lines[0].match(LIST_ITEM)[2]);
  const start = ordered ? parseInt(lines[0].match(LIST_ITEM)[2], 10) : 1;
  const items = [];
  for (const l of lines) {
    const m = l.match(LIST_ITEM);
    if (m && m[1].length <= base + 1) items.push([m[3]]);
    else items.at(-1)?.push(l.slice(Math.min(base + 2, l.length - l.trimStart().length)));
  }
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map(([first, ...rest]) => {
    const nested = rest.filter((r) => r !== undefined);
    const inner = nested.length ? blocks([first, ...nested], ctx) : inline(first, ctx);
    // A single-paragraph item renders without the <p> wrapper.
    return `<li>${inner.replace(/^<p>([\s\S]*?)<\/p>(?=<|$)/, '$1')}</li>`;
  });
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${lis.join('')}</${tag}>`;
}

function table(rows, _lines, ctx) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const [head, ...body] = rows.map(cells);
  const th = head.map((c) => `<th>${inline(c, ctx)}</th>`).join('');
  const trs = body.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', ctx)}</td>`).join('')}</tr>`).join('');
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

// ── Inline ──────────────────────────────────────────────────────────────────────────────

function inline(s, ctx) {
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

function glossaryRegex(glossary) {
  const entries = (glossary ?? []).filter((g) => g?.term && g?.key);
  if (!entries.length) return null;
  const keys = new Map(entries.map((g) => [escapeHtml(g.term).toLowerCase(), g.key]));
  const alts = [...keys.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { re: new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'gi'), keys };
}

function mentionRegex(handles) {
  const hs = (handles ?? []).filter((h) => /^[A-Za-z0-9_-]+$/.test(h));
  if (!hs.length) return null;
  return new RegExp(`(^|[^\\w@])@(${hs.join('|')})(?![\\w-])`, 'g');
}

/** Strips Markdown to plain text, for screen-reader announcements and short previews. */
export function toPlainText(src) {
  return String(src ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<\/?(details|summary)>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}
