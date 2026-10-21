// lint-copy: the writing rules that a machine can check. American spelling everywhere we write (strings,
// comments, the design docs), and curly quotes and apostrophes in what people read in the app.
// See designs/intent.md, “Writing”, and designs/architecture.md.
//
//   node tools/lint-copy.mjs

import { fileURLToPath } from 'node:url';
import { allowed, files, read, report, scan } from './lint-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const ISE =
  'organi|recogni|reali|optimi|prioriti|summari|visuali|customi|initiali|normali|seriali|authori|categori|finali|minimi|maximi|apologi|utili|speciali|standardi|synchroni|saniti|tokeni|memori|capitali|personali|materiali|emphasi|criti|characteri';
const BRITISH = new RegExp(
  [
    `\\b(?:${ISE})s(?:e|es|ed|ing|ation|ations|er|ers)\\b`,
    '\\banalys(?:e|ed|ing)\\b',
    '\\b\\w*(?:col|behavi|fav|hon|lab|neighb|hum|flav|rum|sav|arm|vap|harb|endeav)our\\w*\\b',
    '\\b(?:cent|met|theat|fib|lit|calib|somb|spect)re[sd]?\\b',
    '\\b(?:catalogue|analogue|programme|grey|cheque|defence|offence|licence|artefact|judgement|whilst|amongst|learnt|spelt|aluminium|ageing|enrol|fulfil|skilful|storey|tyre|manoeuvre|mould|sceptic\\w*|draught|jewellery)s?\\b',
    '\\b(?:travel|cancel|label|model|signal|level|fuel|total|counsel|marshal|channel|tunnel|funnel|panel|quarrel|dial|equal|pedal|jewel|rival|shovel|duel|grovel|revel|swivel|unravel)l(?:ed|ing|er|ers)\\b',
  ].join('|'),
  'i',
);
/** British spellings in a piece of text. */
export function britishWords(text) {
  const out = [];
  const re = new RegExp(BRITISH.source, 'gi');
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/** Straight quotes or apostrophes used as prose in a string people read. */
export function straightQuotes(text) {
  const out = [];
  if (/[A-Za-z]'[A-Za-z]/.test(text)) out.push(text.match(/\S*[A-Za-z]'[A-Za-z]\S*/)?.[0]);
  // A double quote that opens prose: after a space or the start, before a letter, and not an attribute value.
  const m = text.match(/(?:^|[\s(])"[A-Za-z][^"=<>]*"(?=[\s.,;:!?)]|$)/);
  if (m) out.push(m[0].trim());
  return out.filter(Boolean);
}

/** Code-like strings are not prose: selectors, CSS, HTML attributes, paths, identifiers. */
const looksLikeCode = (s) => /^[\w$.:/#\-[\]=*>~+^|()@,\s]*$/.test(s) && !/\s\w+\s\w+/.test(s);

export function checkJs(text, file) {
  const lines = text.split('\n');
  const findings = [];
  const add = (line, rule, message) => {
    if (!allowed(lines, line, rule)) findings.push({ file, line, message });
  };
  for (const t of scan(text)) {
    if (t.kind === 'regex') continue;
    // A template can span many lines; check each, so a finding points at its own line.
    t.text.split('\n').forEach((part, k) => {
      for (const w of britishWords(part)) add(t.line + k, 'spelling', `British spelling “${w}”. Postbox uses American spelling.`);
      if (t.kind === 'comment' || looksLikeCode(part)) return;
      // Code shown as code keeps its straight quotes.
      const prose = part.replace(/<code>.*?<\/code>/g, ' ').replace(/`[^`]*`/g, ' ');
      for (const q of straightQuotes(prose)) add(t.line + k, 'quotes', `Straight quote in text people read: “${q}”. Use ’ or “ ”.`);
    });
  }
  return findings;
}

/** Docs: spelling only, outside code spans and fences, since code keeps straight quotes and real names. */
export function checkMarkdown(text, file) {
  const findings = [];
  let fence = false;
  const lines = text.split('\n');
  lines.forEach((l, n) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const prose = l.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
    for (const w of britishWords(prose)) {
      if (!allowed(lines, n + 1, 'spelling')) findings.push({ file, line: n + 1, message: `British spelling “${w}”. Postbox uses American spelling.` });
    }
  });
  return findings;
}

/** The app’s HTML: text between tags, with attributes and scripts left out. */
export function checkHtml(text, file) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((l, n) => {
    const prose = l.replace(/<[^>]*>/g, ' ');
    for (const w of britishWords(prose)) if (!allowed(lines, n + 1, 'spelling')) findings.push({ file, line: n + 1, message: `British spelling “${w}”.` });
    for (const q of straightQuotes(prose))
      if (!allowed(lines, n + 1, 'quotes')) findings.push({ file, line: n + 1, message: `Straight quote in the page text: “${q}”.` });
  });
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = [];
  const code = files(ROOT, ['app', 'server', 'shared', 'tools/demo.mjs'], ['.js', '.mjs'], ['app/kit/vendor', 'server/corpus/books']);
  for (const f of code) findings.push(...checkJs(read(ROOT, f), f));
  for (const f of files(ROOT, ['app/index.html'], ['.html'])) findings.push(...checkHtml(read(ROOT, f), f));
  for (const f of files(ROOT, ['designs', 'README.md'], ['.md'])) findings.push(...checkMarkdown(read(ROOT, f), f));
  report('lint-copy', findings);
}
