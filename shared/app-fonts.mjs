// An agent’s app takes Postbox’s own type (#1322): the sandbox inlines app/workbench.css, which gives text its text
// stack and code its mono stack, so an app that applies another font looks foreign beside the conversation, and
// stacks that resolve differently per browser draw apps in different families (#44). The catalog’s app check refuses
// code that applies one, before anything is shown. Pure and node-free, as the catalog is.
//
// Only what the app applies is read (shared/app-code-scan.mjs): CSS in <style> and in style attributes, SVG’s
// font-family attribute, and script that sets a font (a style’s fontFamily, a canvas font, a d3 or setAttribute
// font-family). Text it only shows, comments, and a script’s strings are never read. What it can’t read, such as a
// family held in a variable, is left alone rather than refused. Every step is linear in the code’s length, since
// validateBlock runs it on the server.

import { htmlParts, scriptTokens, withoutCssComments } from './app-code-scan.mjs';

/** workbench.css’s stacks, as the refusal and show_app’s description name them; tests/app-fonts.test.mjs reads them there. */
// lint-allow quotes: a CSS font stack an agent copies, whose quotes are CSS’s.
export const TEXT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
// lint-allow quotes: a CSS font stack an agent copies, whose quotes are CSS’s.
export const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const QUOTES = new Set(['"', "'", '`']);
/** A family with its quotes, a trailing ) and !important taken off, by loops rather than a pattern. @param {string} raw */
function unquoted(raw) {
  let f = raw.trim();
  if (f.toLowerCase().endsWith('!important')) f = f.slice(0, -'!important'.length).trim();
  let a = 0;
  let b = f.length;
  while (a < b && QUOTES.has(f[a])) a++;
  while (b > a && (QUOTES.has(f[b - 1]) || f[b - 1] === ')')) b--;
  return f.slice(a, b);
}

/** A stack’s families, unquoted, as the code writes them, in order. @param {string} list */
const familiesIn = (list) => list.split(',').map(unquoted).filter(Boolean);

/** The families in workbench.css’s stacks, lower case. */
export const STACK_FONTS = new Set(familiesIn(`${TEXT_STACK}, ${MONO_STACK}`).map((f) => f.toLowerCase()));

/**
 * Other names for faces in those stacks, by the name the stack uses. Agents write them in the usual system stacks,
 * as the showcase’s recorded apps do (tools/demo/showcase/): they’re the same faces, not fonts of their own.
 */
export const FACE_ALIASES = Object.freeze({ 'sfmono-regular': 'sf mono', blinkmacsystemfont: '-apple-system' });

// CSS’s generic families (CSS Fonts 4), which each browser maps to a face of its own, and the keywords that keep
// what the app inherits. An app may name any of them: serif for a quote is the app’s choice, not a font it brings.
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);
const KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
// The emoji faces each platform draws emoji with: they draw only emoji, so they may come anywhere in a stack.
const EMOJI = new Set(['apple color emoji', 'segoe ui emoji', 'segoe ui symbol', 'noto color emoji']);
// The platform faces the usual system stacks fall back to, after the system face (Bootstrap’s and GitHub’s stacks):
// taken after a family an app may name, which the browser draws first, but not first, where it’d be the app’s font.
const FALLBACKS = new Set([
  'roboto',
  'helvetica neue',
  'helvetica',
  'arial',
  'noto sans',
  'liberation sans',
  'ubuntu',
  'cantarell',
  'liberation mono',
  'courier new',
  'courier',
  'dejavu sans mono',
]);

/** A shorthand’s size, after which its families come: 14px, 1.2em, 14px/1.4, or a template’s ${size}px. */
const SIZE = /^(?:[\d.]+|\$\{[^}]*\})(?:px|em|rem|pt|pc|%|ex|ch|vh|vw|vmin|vmax)(?:\/\S+)?$/i;
const SIZE_WORDS = /^(?:xx?-small|small|medium|large|xx?-large|xxx-large|smaller|larger)(?:\/\S+)?$/i;

/** The stack a shorthand names, or none when it names none or can’t be read. @param {string} value */
function shorthandStack(value) {
  const tokens = value.trim().split(/\s+/);
  const size = tokens.findIndex((t) => t.length < 40 && (SIZE.test(t) || SIZE_WORDS.test(t)));
  return size === -1 ? [] : familiesIn(tokens.slice(size + 1).join(' '));
}

/** The stacks CSS declarations apply: font-family and the font shorthand. @param {string} css  with comments taken out */
const cssStacks = (css) => [
  ...[...css.matchAll(/font-family\s*:([^;}]*)/gi)].map((m) => familiesIn(m[1])),
  ...[...css.matchAll(/(?<![\w-])font\s*:([^;}]*)/gi)].map((m) => shorthandStack(m[1])),
];

/** The stacks a tag’s attribute applies: a style attribute’s CSS, and SVG’s font-family. @param {{ name: string, value: string }} a */
function attributeStacks(a) {
  const name = a.name.toLowerCase();
  if (name === 'style') return cssStacks(a.value);
  return name === 'font-family' ? [familiesIn(a.value)] : [];
}

/**
 * The stacks a script sets, read from its code and the string each setter takes: `fontFamily = '…'` or
 * `fontFamily: '…'`, a canvas or style `.font = '…'`, and `('font-family', '…')` for d3 or setAttribute.
 * Strings anywhere else are text the script holds, not fonts it applies. @param {string} js
 */
function scriptStacks(js) {
  const tokens = scriptTokens(js);
  const stacks = [];
  for (const [k, t] of tokens.entries()) {
    if (t.kind !== 'string') continue;
    const before = tokens[k - 1]?.kind === 'code' ? tokens[k - 1].text.slice(-80) : '';
    if (/\bfontFamily\s*[:=]\s*$/.test(before)) stacks.push(familiesIn(t.text));
    else if (/\.font\s*=\s*$/.test(before)) stacks.push(shorthandStack(t.text));
    else if (t.text.toLowerCase() === 'font-family' && /^\s*,\s*$/.test(tokens[k + 1]?.text.slice(0, 80) ?? '') && tokens[k + 2]?.kind === 'string')
      stacks.push(familiesIn(tokens[k + 2].text));
  }
  return stacks;
}

/** Whether an app may name a family: Postbox’s, a generic one, a token, or one the scan can’t judge. @param {string} family */
function allowed(family) {
  const f = family.toLowerCase();
  if (STACK_FONTS.has(f) || Object.hasOwn(FACE_ALIASES, f) || GENERIC.has(f) || KEYWORDS.has(f) || EMOJI.has(f)) return true;
  return f.startsWith('var(--') || f.includes('${') || !/^[\w\s.-]+$/.test(f);
}

/** The first family in a stack the app may not name, or undefined: a fallback may follow, never lead. @param {string[]} stack */
const ownFont = (stack) => stack.find((f, i) => !allowed(f) && !(i > 0 && FALLBACKS.has(f.toLowerCase())));

/** What an app may use instead, as the refusal and show_app’s description say it. */
export const FONT_RULE = `leave the font out, or use Postbox’s text stack (${TEXT_STACK}), its mono stack (${MONO_STACK}) or a generic family such as serif, which the usual platform fallbacks (Roboto, Helvetica, Arial) may follow`;

/**
 * The catalog’s app check: one error naming the first font the code applies that isn’t Postbox’s, if any.
 * @param {unknown} code  the app’s code @param {string[]} errs
 */
export function appFontErrors(code, errs) {
  if (typeof code !== 'string') return;
  const { styles, scripts, attributes } = htmlParts(code);
  const css = styles.map(withoutCssComments);
  const how = `An app takes Postbox’s type, so ${FONT_RULE}.`;
  if (css.some((s) => /@font-face\b/i.test(s))) return void errs.push(`code declares a font with @font-face. ${how}`);
  const stacks = [...css.flatMap(cssStacks), ...attributes.flatMap(attributeStacks), ...scripts.flatMap(scriptStacks)];
  for (const stack of stacks) {
    const own = ownFont(stack);
    if (own) return void errs.push(`code applies a font Postbox doesn’t use, “${own}”. ${how}`);
  }
}
