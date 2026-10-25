// Inline Markdown: code spans, math, links, citations, bare links, emphasis, glossary terms and @mentions inside
// one line of text. Moved out of shared/markdown.mjs, which renders the blocks and calls inline for their text. All
// text is escaped, as there.

import { mathAt } from './math.mjs';
import { isSafeUrl, LOCAL_HTTP, onPageOrigin } from './urls.mjs';

const LABEL_MAX = 1000;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
/** HTML as text, its tags removed. One pass of this pattern leaves none; the loop says so where CodeQL can see it (#345). */
export function stripTags(html) {
  let text = String(html);
  for (let was = ''; was !== text; ) {
    was = text;
    // lint-allow tags: this is stripTags, repeated until no tag is left.
    text = text.replace(/<[^>]+>/g, '');
  }
  return text;
}

// ── Inline ──────────────────────────────────────────────────────────────────────────────

/**
 * One line of text as HTML. at, when the render marks source positions (#179), is where s starts in the source: the
 * 0-based line n and offset c. Each run of text, and each link, image, math or citation, is then wrapped in a span
 * naming the line (data-sl, 1-based) and the offsets in it (data-sc to data-se, 0-based, end exclusive) it came from.
 * @param {string} s @param {any} ctx @param {{ n: number, c: number }} [at]
 */
export function inline(s, ctx, at) {
  let out = '',
    buf = '',
    i = 0,
    from = 0;
  // Code spans bind tighter than emphasis, so **`x`** is bold: each span waits in the text run as a
  // U+0000 and goes back in, in order, once the run's emphasis is applied.
  const codes = [];
  const mark = (html, a, z) => (at && html ? `<span data-sl="${at.n + 1}" data-sc="${at.c + a}" data-se="${at.c + z}">${html}</span>` : html);
  const flush = () => {
    out += mark(
      textRun(buf, ctx).replace(/\0/g, () => codes.shift()),
      from,
      i,
    );
    buf = '';
  };
  // Something drawn from s[i] to s[end], after the text before it.
  const piece = (html, end) => {
    flush();
    out += mark(html, i, end);
    i = from = end;
  };
  while (i < s.length) {
    const c = s[i];
    const math = c === '$' || c === '\\' ? mathAt(s, i) : null;
    if (math) {
      piece(`<span class="md-math"${math.display ? ' data-display="true"' : ''}>${escapeHtml(math.tex)}</span>`, math.end);
      continue;
    }
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!|$~>@]/.test(s[i + 1] ?? '')) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const run = /** @type {RegExpMatchArray} */ (s.slice(i).match(/^`+/))[0];
      const end = s.indexOf(run, i + run.length);
      if (end > -1) {
        const code = s.slice(i + run.length, end).replace(/^ (.*) $/, '$1');
        codes.push(`<code>${escapeHtml(ctx.cell ? code.replace(/\\\|/g, '|') : code)}</code>`);
        buf += '\0';
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    const ref = c === '[' || (c === '!' && s[i + 1] === '[') ? bracket(s, i, ctx) : null;
    if (ref) {
      piece(ref.html, ref.end);
      continue;
    }

    // Streaming text can stop right after “https://”, so the full match may not be there yet.
    const bare = !ctx.inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(s[i - 1])) ? s.slice(i).match(/^https?:\/\/[^\s<>"]+/i) : null;
    if (bare) {
      const url = bare[0].replace(/[.,;:!?)\]'”’]+$/, '');
      if (isSafeUrl(url)) {
        piece(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`, i + url.length);
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/**
 * The index of what closes the ( at s[open], or another pair such as '[]', counting nested pairs; -1 if none does
 * before limit.
 */
function matchParen(s, open, [a, b] = '()', limit = s.length) {
  let depth = 0;
  for (let j = open; j < Math.min(s.length, limit); j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === a) depth++;
    else if (s[j] === b && --depth === 0) return j;
  }
  return -1;
}

/**
 * What starts at s[i], a [ or an image’s !: a link, an image, or the marker of a source that exists. Anything else is
 * text, and gets null.
 * @param {string} s @param {number} i @param {any} ctx
 * @returns {{ html: string, end: number } | null}  end is the index just after it
 */
function bracket(s, i, ctx) {
  const image = s[i] === '!';
  const open = image ? i + 1 : i;
  // Brackets nest, so an image can be a link’s text. A label is looked for over the next LABEL_MAX characters only, so
  // a line of unclosed brackets isn’t scanned to its end from each one.
  const close = matchParen(s, open, '[]', open + LABEL_MAX);
  if (close < 0) return null;
  const label = s.slice(open + 1, close);
  // A link’s text holds no link, since an <a> can’t hold another.
  if (s[close + 1] === '(' && !(ctx.inLink && !image)) {
    const end = matchParen(s, close + 1);
    if (end < 0) return null;
    const target = s.slice(close + 2, end).trim();
    return { html: image ? img(label, target, ctx) : link(label, target, ctx), end: end + 1 };
  }
  if (image || !/^\d{1,3}$/.test(label) || !ctx.citations || +label < 1 || +label > ctx.citations) return null;
  const n = +label;
  return { html: `<a class="cite" href="#${escapeHtml(ctx.citeId ?? 'src')}-${n}" data-cite="${n}" aria-label="Source ${n}">${n}</a>`, end: close + 1 };
}

/**
 * An image (#218): https, or plain http for Postbox’s own media on this computer, moved to the page’s origin as an
 * image block’s is (#180). The page’s Content-Security-Policy decides which origins load. Any other address is said
 * in its place, with the alt text.
 * @param {string} alt @param {string} target  the address, and any title after it @param {{ pageOrigin?: string }} ctx
 */
function img(alt, target, ctx) {
  const src = target.split(/\s+/)[0];
  const local = LOCAL_HTTP.test(src);
  if (!isSafeUrl(src, { schemes: local ? ['http:'] : ['https:'] }))
    return `<span class="md-img-failed">This image couldn’t load: its address isn’t a full https address.${alt ? ` It shows: ${escapeHtml(alt)}` : ''}</span>`;
  const at = local && ctx.pageOrigin ? onPageOrigin(src, ctx.pageOrigin) : src;
  return `<img class="md-img" src="${escapeHtml(at)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
}

function link(label, target, ctx) {
  const text = inline(label, { ...ctx, citations: 0, inLink: true });
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
  // lint-allow regex: glossary terms, each escaped just above.
  return { re: new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'gi'), keys };
}

export function mentionRegex(handles) {
  const hs = (handles ?? []).filter((h) => /^[A-Za-z0-9_-]+$/.test(h));
  if (!hs.length) return null;
  // lint-allow regex: only handles of letters, digits, _ and - are kept, just above.
  return new RegExp(`(^|[^\\w@])@(${hs.join('|')})(?![\\w-])`, 'g');
}
