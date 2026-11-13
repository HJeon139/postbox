// An agent’s app takes Postbox’s own type (#1322): the sandbox inlines app/workbench.css, which gives text system-ui
// and code Postbox’s mono stack, so an app that names another font looks foreign beside the conversation, and stacks
// that resolve differently per browser draw apps in different families (#44). The catalog’s app check refuses code
// that names one, before anything is shown. Pure and node-free, as the catalog is.
//
// A scan of the code’s text, not a CSS parser: it reads the ways apps set a font (@font-face, font-family in CSS or
// SVG, the font shorthand, a style’s fontFamily, a canvas font, a d3 or setAttribute font-family) and leaves alone
// what it can’t read, such as a family held in a variable, rather than refuse an app for it.

/**
 * The families an app may name: workbench.css’s body and mono stacks (tests/app-fonts.test.mjs reads them there), and
 * the keywords that keep what the app inherits. Lower case, without quotes.
 */
export const APP_FONTS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'system-ui',
  '-apple-system',
  'segoe ui',
  'sans-serif',
  'ui-monospace',
  'sf mono',
  'menlo',
  'consolas',
  'monospace',
]);

// Where a family list is written: CSS’s font-family or SVG’s attribute (to the end of the declaration, or the
// attribute’s quotes), a style’s fontFamily, and font-family as a d3 or setAttribute name.
const FAMILY_LISTS = [
  /font-family\s*=\s*(["'])(.*?)\1/gi,
  /font-family\s*:\s*([^;}<\n]*)/gi,
  /fontFamily\s*[:=]\s*(["'`])(.*?)\1/g,
  /(["'])font-family\1\s*,\s*(["'`])(.*?)\2/gi,
];
// Where a shorthand is written: CSS’s font, and a canvas context’s font.
const SHORTHANDS = [/(?<![\w-])font\s*:\s*([^;}<\n"'`]*)/gi, /\.font\s*=\s*(["'`])(.*?)\1/g];
/** A shorthand’s size, after which its families come: 14px, 1.2em, 14px/1.4, or a template’s ${size}px. */
const SIZE = /^(?:[\d.]+|\$\{[^}]*\})(?:px|em|rem|pt|pc|%|ex|ch|vh|vw|vmin|vmax)(?:\/\S+)?$/i;
const SIZE_WORDS = /^(?:xx?-small|small|medium|large|xx?-large|xxx-large|smaller|larger)(?:\/\S+)?$/i;

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

/** The families a shorthand names, or none when it names none or can’t be read. @param {string} value */
function shorthandFamilies(value) {
  const tokens = value.trim().split(/\s+/);
  const size = tokens.findIndex((t) => SIZE.test(t) || SIZE_WORDS.test(t));
  return size === -1 ? [] : familiesIn(tokens.slice(size + 1).join(' '));
}

/** Whether a family is Postbox’s, a token, or one the scan can’t judge. @param {string} family */
const allowed = (family) => APP_FONTS.has(family.toLowerCase()) || family.startsWith('var(--') || family.includes('${') || !/^[\w\s.-]+$/.test(family);

/**
 * The catalog’s app check: one error naming the first font the code sets that isn’t Postbox’s, if any.
 * @param {unknown} code  the app’s code @param {string[]} errs
 */
export function appFontErrors(code, errs) {
  if (typeof code !== 'string') return;
  const how = 'an app takes Postbox’s type, so leave the font out, or use inherit, system-ui, sans-serif or monospace.';
  if (/@font-face\b/i.test(code)) return void errs.push(`code declares a font with @font-face: ${how}`);
  const named = [
    ...FAMILY_LISTS.flatMap((re) => [...code.matchAll(re)].flatMap((m) => familiesIn(m.at(-1) ?? ''))),
    ...SHORTHANDS.flatMap((re) => [...code.matchAll(re)].flatMap((m) => shorthandFamilies(m.at(-1) ?? ''))),
  ];
  const own = named.find((f) => !allowed(f));
  if (own) errs.push(`code names a font Postbox doesn’t use, “${own}”: ${how}`);
}
