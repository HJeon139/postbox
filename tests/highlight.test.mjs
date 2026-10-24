import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlight } from '../shared/highlight.mjs';

/** The text of each token of a kind, in order. */
const of = (tokens, kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);

test('a language it doesn’t know, or none, comes back as one plain token', () => {
  assert.deepEqual(highlight('let x = 1;', 'cobol'), [{ kind: null, text: 'let x = 1;' }]);
  assert.deepEqual(highlight('let x = 1;'), [{ kind: null, text: 'let x = 1;' }]);
  // An inherited name isn’t a language (#39).
  assert.deepEqual(highlight('x', 'constructor'), [{ kind: null, text: 'x' }]);
});

test('TypeScript, named in any case, colors its keywords, strings, numbers, called functions and comments', () => {
  const t = highlight(`export function span(p) {\n  return { end: 0x1F, at: \`\${p}\`, unit: "char", n: 1.5e3 }; // offsets\n}`, 'TS');
  assert.deepEqual(of(t, 'kw'), ['export', 'function', 'return']);
  assert.deepEqual(of(t, 'fn'), ['span']);
  assert.deepEqual(of(t, 'num'), ['0x1F', '1.5e3']);
  assert.deepEqual(of(t, 'str'), [`\`\${p}\``, '"char"']);
  assert.deepEqual(of(t, 'com'), ['// offsets']);
});

test('a comment or string over several lines is one token, and an unclosed comment runs to the end', () => {
  assert.deepEqual(of(highlight('/* a\n b */ x', 'js'), 'com'), ['/* a\n b */']);
  assert.deepEqual(of(highlight('x = `a\nb`', 'js'), 'str'), ['`a\nb`']);
  assert.deepEqual(of(highlight('x /* open\nstill', 'js'), 'com'), ['/* open\nstill']);
  assert.deepEqual(of(highlight('"""Doc\nstring."""\npass', 'python'), 'str'), ['"""Doc\nstring."""']);
});

test('a keyword or comment marker inside a string stays part of the string', () => {
  const t = highlight('s = "return // not a comment" # but this is', 'py');
  assert.deepEqual(of(t, 'str'), ['"return // not a comment"']);
  assert.deepEqual(of(t, 'com'), ['# but this is']);
  assert.deepEqual(of(t, 'kw'), []);
});

test('in a shell script, # starts a comment only at the start of a line or after a space', () => {
  const t = highlight(`echo \${#name} $#\n# a comment`, 'bash');
  assert.deepEqual(of(t, 'com'), ['# a comment']);
});

test('SQL keywords match in any case; names don’t', () => {
  const t = highlight("SELECT id FROM passages where book = 'middlemarch' -- one book", 'sql');
  assert.deepEqual(of(t, 'kw'), ['SELECT', 'FROM', 'where']);
  assert.deepEqual(of(t, 'str'), ["'middlemarch'"]);
  assert.deepEqual(of(t, 'com'), ['-- one book']);
});

test('a digit inside a name isn’t a number', () => {
  assert.deepEqual(of(highlight('const x1 = y2 + 3;', 'js'), 'num'), ['3']);
});

test('the tokens join back to the code, with plain text merged, for every family', () => {
  const code = 'fn main() {\n  let s = "a\\"b"; /* c */ // d\n}\n# e\n\'f\' -- g\n`h`';
  for (const lang of ['js', 'json', 'python', 'shell', 'sql', 'rust', 'none']) {
    const t = highlight(code, lang);
    assert.equal(t.map((x) => x.text).join(''), code, lang);
    assert.ok(
      t.every((x, i) => x.text && !(x.kind === null && t[i + 1]?.kind === null)),
      `${lang}: no empty tokens, and no two plain ones in a row`,
    );
  }
});

// Review of #41: an unclosed string was tried again at every later quote, which took 15 s on this line.
test('a string that isn’t closed runs to the end of its line, so a long line of them takes no time', { timeout: 2000 }, () => {
  assert.deepEqual(of(highlight('x = "open\ny = 2', 'js'), 'str'), ['"open']);
  assert.deepEqual(of(highlight("it's\nfine", 'shell'), 'str'), ["'s"]);
  assert.deepEqual(of(highlight("s = '''open\nmore", 'python'), 'str'), ["'''open\nmore"]);
  const long = `"${'\\"'.repeat(100_000)}`;
  assert.deepEqual(of(highlight(long, 'js'), 'str'), [long]);
  for (const lang of ['js', 'python', 'sql', 'go'])
    assert.equal(
      highlight(`'\\`.repeat(66_000), lang)
        .map((t) => t.text)
        .join('').length,
      132_000,
      lang,
    );
});

test('in Python, # starts a comment right after code too', () => {
  assert.deepEqual(of(highlight('x = 1# note\nprint(a)#c', 'python'), 'com'), ['# note', '#c']);
});

test('a Rust lifetime isn’t a string, and a character literal is', () => {
  const t = highlight("fn f<'a>(x: &'a str) -> char { '\\n' }", 'rust');
  assert.deepEqual(of(t, 'str'), ["'\\n'"]);
});

test('a word after a dot is a property, not a keyword', () => {
  const t = highlight('if (b.type === x.default) map.delete(k);', 'ts');
  assert.deepEqual(of(t, 'kw'), ['if']);
  assert.deepEqual(of(t, 'fn'), ['delete']);
});
