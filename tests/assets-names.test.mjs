// #704: an asset’s name has no character that hides or reorders what the page shows of it (server/assets.mjs,
// nameProblem): no C0 or C1 control, no bidi control, no line or paragraph separator, no other invisible format
// character, none of the other characters that show as nothing (shared/invisible.mjs: Hangul fillers, the combining
// grapheme joiner, variation selectors, the tag block; and the blank braille pattern), and no lone surrogate or
// noncharacter. A name already stored with one keeps loading and taking new versions; only a new name is refused.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetBlobs, nameProblem, writeAsset } from '../server/assets.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const REFUSED =
  'An asset’s name has no backslash, control character, line or paragraph separator, lone surrogate, noncharacter, or character that shows as nothing or reorders the text, such as a zero-width space, a bidi control or a variation selector.';

/** One example of each class a name refuses, by what it is. */
const HIDDEN = {
  'a C0 control': 'a\u0005b.md',
  NUL: 'nul\u0000.md',
  DEL: 'del\u007f.md',
  'a C1 control': 'a\u0085b.md',
  'the last C1 control': 'a\u009fb.md',
  'an Arabic letter mark': 'a\u061cb.md',
  'a left-to-right mark': 'a\u200eb.md',
  'a right-to-left mark': 'a\u200fb.md',
  'a left-to-right embedding': 'a\u202ab.md',
  'a right-to-left override': 'cod\u202etxt.exe',
  'a left-to-right isolate': 'a\u2066b.md',
  'a pop directional isolate': 'a\u2069b.md',
  'a line separator': 'a\u2028b.md',
  'a paragraph separator': 'a\u2029b.md',
  'a zero-width space': 'a\u200bb.md',
  'a zero-width joiner': 'a\u200db.md',
  'a byte order mark': '\ufeffplan.md',
  'a backslash': 'back\\slash.md',
  'the Hangul choseong filler': 'a\u115fb.md',
  'the Hangul jungseong filler': 'a\u1160b.md',
  'the Hangul filler': 'a\u3164b.md',
  'the halfwidth Hangul filler': 'a\uffa0b.md',
  'a combining grapheme joiner': 'a\u034fb.md',
  'the first variation selector': 'a\ufe00b.md',
  'the last variation selector': 'a\ufe0fb.md',
  'the first tag character': 'a\u{e0000}b.md',
  'a tag letter': 'a\u{e0041}b.md',
  'the last tag character': 'a\u{e007f}b.md',
  'a lone high surrogate': 'a\ud800b.md',
  'a lone low surrogate': 'a\udfffb.md',
  'a lone surrogate at the end': 'plan.md\ud83d',
  'the blank braille pattern': 'a\u2800b.md',
  'the noncharacter U+FFFE': 'a\ufffeb.md',
  'the noncharacter U+FFFF': 'a\uffffb.md',
};

for (const [what, name] of Object.entries(HIDDEN))
  test(`a name with ${what} is refused, saying what a name can’t hold`, () => {
    assert.equal(nameProblem(name), REFUSED);
  });

test('a plain name in any script passes, quotes, < and & included', () => {
  for (const name of ['é.md', 'Café/ü.txt', '日本/メモ.md', 'Ελληνικά.md', 'עברית.md', 'العربية.md', 'q"<&>.md', 'a b.md', '😀.md', '⠁⠃.md'])
    assert.equal(nameProblem(name), null, name);
});

test('a name with a hidden character hears that first, whatever else is wrong with it', () => {
  assert.equal(nameProblem('/a\u202eb.md'), REFUSED);
  assert.equal(nameProblem('a//\u2800.md'), REFUSED);
  assert.equal(nameProblem('/plain.md'), 'An asset’s name is relative to the room: it doesn’t start with /.');
  assert.equal(nameProblem('a/../b.md'), 'An asset’s name has no empty, . or .. part.');
});

/** A store with one conversation, and a write into it through the one commit path. */
function room() {
  const store = new Store(null);
  store.emit('thread', { id: 'th_1', members: [] });
  const blobs = assetBlobs(tempDir('pb-asset-names-'));
  const write = (req) => writeAsset(store, blobs, { kind: 'write', room: 'th_1', type: 'text/markdown', author: 'dev', ...req });
  return { store, blobs, write };
}

test('a new asset or a rename with a bidi override is refused, and nothing is stored', async () => {
  const { store, blobs, write } = room();
  const made = await write({ name: 'cod\u202etxt.exe', bytes: Buffer.from('x') });
  assert.deepEqual([made.ok, made.message], [false, REFUSED]);
  assert.deepEqual(Object.keys(store.state.assets ?? {}), []);
  const plain = await write({ name: 'plan.md', bytes: Buffer.from('x') });
  assert.equal(plain.ok, true);
  const renamed = await writeAsset(store, blobs, { kind: 'rename', room: 'th_1', id: plain.id, base: 1, name: 'a\u2028b.md', author: 'dev' });
  assert.deepEqual([renamed.ok, renamed.message], [false, REFUSED]);
  assert.equal(store.state.assets[plain.id].name, 'plan.md');
});

test('a second name that differs from the first only by a variation selector is refused, and only the first is stored', async () => {
  const { store, write } = room();
  const first = await write({ name: 'star.md', bytes: Buffer.from('one') });
  assert.equal(first.ok, true, first.message);
  const second = await write({ name: 'star\ufe0f.md', bytes: Buffer.from('two') });
  assert.deepEqual([second.ok, second.message], [false, REFUSED]);
  assert.deepEqual(
    Object.values(store.state.assets).map((a) => a.name),
    ['star.md'],
  );
});

test('a name sent decomposed (NFD) is stored composed (NFC)', async () => {
  const { store, write } = room();
  const made = await write({ name: 'Cafe\u0301/u\u0308.md', bytes: Buffer.from('x') });
  assert.equal(made.ok, true, made.message);
  assert.equal(store.state.assets[made.id].name, 'Caf\u00e9/\u00fc.md');
});

test('a name already stored with a bidi override keeps loading and takes a new version by its id', async () => {
  const { store, write } = room();
  const made = await write({ name: 'old.md', bytes: Buffer.from('one') });
  // As an older Postbox stored it: the event itself, which nameProblem never reads.
  store.emit('asset', { ...store.state.assets[made.id], name: 'old\u202ename.md' });
  assert.equal(store.state.assets[made.id].name, 'old\u202ename.md');
  const next = await write({ id: made.id, base: 1, bytes: Buffer.from('two') });
  assert.equal(next.ok, true, next.message);
  assert.deepEqual([store.state.assets[made.id].name, store.state.assets[made.id].head], ['old\u202ename.md', 2]);
});
