// An agent’s app takes Postbox’s own type (#1322): the sandbox inlines app/workbench.css, which gives text its text
// stack and code its mono stack, so an app that applies another font looks foreign beside the conversation, and
// stacks that resolve differently per browser draw apps in different families (#44). The catalog’s app check refuses
// code that applies one, before anything is shown. Pure and node-free, as the catalog is.
//
// Only what the app applies is read: CSS in <style> and in style attributes, SVG’s font-family attribute, and script
// that sets a font (a style’s fontFamily, a canvas font, a d3 or setAttribute font-family). Text it only shows, in
// <pre>, <code>, a comment or a script’s string, is never read, so a CSS lesson isn’t refused. What it can’t read,
// such as a family held in a variable, is left alone rather than refused.

/** workbench.css’s stacks, as the refusal and show_app’s description name them; tests/app-fonts.test.mjs reads them there. */
// lint-allow quotes: a CSS font stack an agent copies, whose quotes are CSS’s.
export const TEXT_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
// lint-allow quotes: a CSS font stack an agent copies, whose quotes are CSS’s.
export const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The families in a list, unquoted, as the code writes them. @param {string} list */
const familiesIn = (list) =>
  list
    .split(',')
    .map((f) =>
      f
        .trim()
        .replace(/!important$/i, '')
        .trim()
        .replace(/^["'`]+|["'`)]+$/g, ''),
    )
    .filter(Boolean);

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

/** A shorthand’s size, after which its families come: 14px, 1.2em, 14px/1.4, or a template’s ${size}px. */
const SIZE = /^(?:[\d.]+|\$\{[^}]*\})(?:px|em|rem|pt|pc|%|ex|ch|vh|vw|vmin|vmax)(?:\/\S+)?$/i;
const SIZE_WORDS = /^(?:xx?-small|small|medium|large|xx?-large|xxx-large|smaller|larger)(?:\/\S+)?$/i;

/** The families a shorthand names, or none when it names none or can’t be read. @param {string} value */
function shorthandFamilies(value) {
  const tokens = value.trim().split(/\s+/);
  const size = tokens.findIndex((t) => SIZE.test(t) || SIZE_WORDS.test(t));
  return size === -1 ? [] : familiesIn(tokens.slice(size + 1).join(' '));
}

/** The families CSS declarations apply: font-family and the font shorthand. @param {string} css  with comments taken out */
const cssFamilies = (css) => [
  ...[...css.matchAll(/font-family\s*:\s*([^;}]*)/gi)].flatMap((m) => familiesIn(m[1])),
  ...[...css.matchAll(/(?<![\w-])font\s*:\s*([^;}]*)/gi)].flatMap((m) => shorthandFamilies(m[1])),
];

// Script that sets a font: a style’s fontFamily, a canvas or style font, and font-family as a d3 or setAttribute name.
const SCRIPT_FAMILIES = [/\bfontFamily\s*[:=]\s*(["'`])(.*?)\1/g, /(["'])font-family\1\s*,\s*(["'`])(.*?)\2/gi];
const SCRIPT_SHORTHANDS = [/\.font\s*=\s*(["'`])(.*?)\1/g];

/**
 * What an app’s code applies, in three parts: its stylesheets, its tags’ attributes (outside script and style, so
 * no text between tags), and its scripts. @param {string} code
 */
function appliedParts(code) {
  const styles = [...code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ''));
  const scripts = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);
  const markup = code.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const attributes = [...markup.matchAll(/<[a-zA-Z][\w:-]*((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)].map((m) => m[1]);
  return { styles, scripts, attributes };
}

/** The families a tag’s attributes apply: its style attribute’s CSS, and SVG’s font-family. @param {string} attrs */
const attributeFamilies = (attrs) =>
  [...attrs.matchAll(/(?:^|\s)(style|font-family)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].flatMap((m) => {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    return m[1].toLowerCase() === 'style' ? cssFamilies(value) : familiesIn(value);
  });

/** Whether an app may name a family: Postbox’s, a generic one, a token, or one the scan can’t judge. @param {string} family */
function allowed(family) {
  const f = family.toLowerCase();
  if (STACK_FONTS.has(f) || Object.hasOwn(FACE_ALIASES, f) || GENERIC.has(f) || KEYWORDS.has(f)) return true;
  return f.startsWith('var(--') || f.includes('${') || !/^[\w\s.-]+$/.test(f);
}

/** What an app may use instead, as the refusal and show_app’s description say it. */
export const FONT_RULE = `leave the font out, or use Postbox’s text stack (${TEXT_STACK}), its mono stack (${MONO_STACK}) or a generic family such as serif`;

/**
 * The catalog’s app check: one error naming the first font the code applies that isn’t Postbox’s, if any.
 * @param {unknown} code  the app’s code @param {string[]} errs
 */
export function appFontErrors(code, errs) {
  if (typeof code !== 'string') return;
  const { styles, scripts, attributes } = appliedParts(code);
  const how = `An app takes Postbox’s type, so ${FONT_RULE}.`;
  if (styles.some((css) => /@font-face\b/i.test(css))) return void errs.push(`code declares a font with @font-face. ${how}`);
  const named = [
    ...styles.flatMap(cssFamilies),
    ...attributes.flatMap(attributeFamilies),
    ...scripts.flatMap((js) => [
      ...SCRIPT_FAMILIES.flatMap((re) => [...js.matchAll(re)].flatMap((m) => familiesIn(m.at(-1) ?? ''))),
      ...SCRIPT_SHORTHANDS.flatMap((re) => [...js.matchAll(re)].flatMap((m) => shorthandFamilies(m.at(-1) ?? ''))),
    ]),
  ];
  const own = named.find((f) => !allowed(f));
  if (own) errs.push(`code applies a font Postbox doesn’t use, “${own}”. ${how}`);
}
