// lint-security: the code rules in SECURITY.md, “How the repository keeps it that way”, each from a class of CodeQL
// alert this repository has had. A finding is allowed by a `lint-allow <rule>: <reason>` comment on its line or the
// one above, so every exception says why it’s safe.
//   - regex (#344): a regular expression built at run time takes only constants, or text through escapeRegExp().
//   - tags (#345): tags are stripped only by stripTags() (shared/markdown-inline.mjs), which repeats until none is left.
//   - page-code (#343): a value spliced into code a browser check runs goes through js() (tools/cdp.mjs), not
//     JSON.stringify, which leaves <, >, U+2028 and U+2029 as they are.
//   - token (#351): a token is compared only in constant time, through sameToken() (server/helpers.mjs).
//   - git (#351): git runs only through runGit() (server/ledger-git.mjs), which sets the read-only safeguards.
//
//   node tools/lint-security.mjs

import { fileURLToPath } from 'node:url';
import { allowed, codeOnly, files, read, report, scan } from './lint-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A pattern that is a constant regex’s own source, such as EDGE.source. */
const CONSTANT_SOURCE = /^\s*[A-Z][A-Z0-9_]*\.source\b/;
/** The calls that run their first argument as code in the page, and Runtime.evaluate’s expression. */
const RUNS_IN_PAGE = /(?:\.evaluate|\.waitFor\w*|\bclickAt|\bev)\(\s*$|\bexpression:\s*$/;
/** Template text that reads as code for the page, however the template gets there (a helper builds most of it). */
const PAGE_TEXT =
  /\b(?:document|window|location|navigator|getComputedStyle|querySelector(?:All)?|getElementById|activeElement|requestAnimationFrame)\b|import\('\/(?:app|shared)\//;
/** What comes just before an index: enough for the patterns above, without copying the whole file each time. */
const before = (code, i) => code.slice(Math.max(0, i - 200), i);

const MESSAGES = {
  regex:
    'A regular expression built at run time. Pass outside text through escapeRegExp() from shared/regex.mjs, or say why every part is a constant with “lint-allow regex: <reason>” (#344).',
  tags: 'Strips tags with one pass of a regular expression. Use stripTags() from shared/markdown-inline.mjs (#345).',
  token: 'A token compared with === or !==, which takes longer the more of it matches. Use sameToken() from server/helpers.mjs.',
  git: 'Runs git directly. Run it through runGit() in server/ledger-git.mjs, which sets the read-only safeguards.',
  'page-code': 'A value spliced into page code with JSON.stringify. Use js() from tools/cdp.mjs, which escapes <, >, U+2028 and U+2029 too (#343).',
};

/** new RegExp(…) whose pattern isn’t one string, a template with nothing spliced in, a constant’s source or escaped text. */
function regexRule({ text, code, at, lineOf }, flag) {
  const codeLines = code.split('\n');
  for (const m of code.matchAll(/\bnew RegExp\(\s*/g)) {
    const p = m.index + m[0].length;
    const first = at.get(p + 1);
    const literal = first && (first.kind === 'string' || (first.kind === 'template' && text[first.end] === '`')) && /^\s*[,)]/.test(text.slice(first.end + 1));
    if (!literal && !CONSTANT_SOURCE.test(text.slice(p)) && !/\bescape(?:RegExp|Re)\(/.test(codeLines[lineOf(p) - 1])) flag(p, 'regex');
  }
}

/** .replace or .replaceAll with a regex that matches a tag (<[^>]…, <\/?[^>]…): one pass that strips tags. */
function tagsRule({ tokens, code }, flag) {
  for (const t of tokens)
    if (t.kind === 'regex' && /<(?:\\\/\??)?\[\^>\]/.test(t.text) && /\.replace(?:All)?\(\s*$/.test(before(code, t.start - 1))) flag(t.start, 'tags');
}

/** A comparison with something named a token on either side, other than null or undefined. */
function tokenRule({ code }, flag) {
  const tokenish = (s) => /(?:^|[.?])[a-z]*[tT]oken$/.test(s);
  const absent = (s) => /^(?:null|undefined)$/.test(s);
  for (const m of code.matchAll(/([\w.?]+)\s*[!=]==?\s*([\w.?]+)/g))
    if ((tokenish(m[1]) || tokenish(m[2])) && !absent(m[1]) && !absent(m[2])) flag(m.index, 'token');
}

/** execFile, spawn and their sync forms with 'git', anywhere but runGit’s own file. */
function gitRule({ code, at }, flag, file) {
  if (file.endsWith('server/ledger-git.mjs')) return;
  for (const m of code.matchAll(/\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"]/g))
    if (at.get(m.index + m[0].length)?.text === 'git') flag(m.index, 'git');
}

/**
 * ${JSON.stringify(…)} or ${J(…)} in a template that is page code: passed straight to evaluate, waitFor, clickAt, ev or
 * Runtime.evaluate, or whose own text reads as code for the page. Decided when the template closes, since that text can
 * come after the splice.
 */
function pageCodeRule({ text, tokens, code }, flag) {
  // The templates open now, innermost last: whether each is passed to the page, its text so far and its JSON splices.
  const open = [];
  for (const t of tokens) {
    if (t.kind !== 'template') continue;
    if (text[t.start - 1] === '`') open.push({ runs: RUNS_IN_PAGE.test(before(code, t.start - 1)), text: '', splices: [] });
    const now = open.at(-1);
    if (!now) continue;
    now.text += t.text;
    if (text[t.end] === '$' && /^\$\{\s*(?:JSON\.stringify|J)\(/.test(text.slice(t.end, t.end + 24))) now.splices.push(t.end);
    if (text[t.end] !== '`') continue;
    open.pop();
    if (now.runs || PAGE_TEXT.test(now.text)) for (const i of now.splices) flag(i, 'page-code');
  }
}

/**
 * The regex, tags, token and git rules cover what Postbox runs (server/, shared/, app/js/, bin/); the page-code rule,
 * the browser checks and the UAT driver in tools/.
 * @param {string} text @param {string} file @param {{ pageCode?: boolean }} [opts]
 */
export function checkJs(text, file, { pageCode = false } = {}) {
  const tokens = scan(text);
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const cx = { text, lines: text.split('\n'), tokens, code: codeOnly(text, tokens), at: new Map(tokens.map((t) => [t.start, t])), lineOf };
  const findings = [];
  const flag = (i, rule) => {
    const line = lineOf(i);
    if (!allowed(cx.lines, line, rule)) findings.push({ file, line, message: MESSAGES[rule] });
  };
  if (pageCode) pageCodeRule(cx, flag);
  else for (const rule of [regexRule, tagsRule, tokenRule, gitRule]) rule(cx, flag, file);
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = [];
  for (const f of files(ROOT, ['server', 'shared', 'app/js', 'bin'], ['.js', '.mjs'])) findings.push(...checkJs(read(ROOT, f), f));
  for (const f of files(ROOT, ['tools'], ['.mjs'])) findings.push(...checkJs(read(ROOT, f), f, { pageCode: true }));
  report('lint-security', findings);
}
