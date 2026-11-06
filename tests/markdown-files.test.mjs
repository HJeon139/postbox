// #780: a review block shows images from the agent’s folder, attached to the block’s revision (designs note
// as_BkHPLMds v3, §1 and §4). renderMarkdown takes files, keyed by each file’s name and kept ref, and an image target
// resolves only when it equals a key byte for byte. Every other relative target is refused, with the rule named.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../shared/markdown.mjs';
import { reviewFileKeys } from '../shared/review-files.mjs';

const pageOrigin = 'http://127.0.0.1:4999';
const fig = { url: '/api/threads/th_1/items/it_1/files/today.png?sha=ab12', width: 640, height: 480 };
const files = { 'figs/today.png': fig, 'today.png': fig };

test('#780 an attached file’s ref renders as the route’s same-origin path, with its width and height', () => {
  const html = renderMarkdown('![Today](figs/today.png)', { pageOrigin, files });
  assert.match(html, /<img class="md-img" src="\/api\/threads\/th_1\/items\/it_1\/files\/today\.png\?sha=ab12"/);
  assert.match(html, /width="640" height="480"/);
  assert.match(html, /alt="Today"/);
});

test('#780 the file’s name matches as well as its ref', () => {
  assert.match(renderMarkdown('![x](today.png)', { pageOrigin, files }), /src="\/api\/threads\/th_1\//);
});

test('#780 without files, a relative image is refused as on main', () => {
  assert.match(renderMarkdown('![x](figs/today.png)', { pageOrigin }), /isn’t a full https address/);
});

for (const target of ['../x.png', '/etc/x.png', 'figs/other.png', './figs/today.png', 'figs/today%2Epng', 'FIGS/today.png', 'figs/today.png.bak', 'figs/today'])
  test(`#780 “${target}” is refused: only an exact key resolves, with no decoding or tidying`, () => {
    const html = renderMarkdown(`![x](${target})`, { pageOrigin, files });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /isn’t a full https address or a file attached to this block/);
  });

test('#780 an https image still renders, and a key never shadows a full address', () => {
  assert.match(renderMarkdown('![x](https://example.com/a.png)', { pageOrigin, files }), /src="https:\/\/example\.com\/a\.png"/);
});

test('#780 a target named like an object’s own property never resolves through its prototype', () => {
  for (const target of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
    assert.doesNotMatch(renderMarkdown(`![x](${target})`, { pageOrigin, files }), /<img/, target);
});

test('#780 the URL and the size come only from the attached record, escaped', () => {
  const evil = { 'a.png': { url: '/x"onerror="alert(1)', width: '9" onload="x', height: 2 } };
  const html = renderMarkdown('![x](a.png)', { pageOrigin, files: evil });
  assert.doesNotMatch(html, /"onerror=|onload=/);
  assert.match(html, /width="0" height="2"/);
});

test('#780 the page keys each file by name and ref, as the route’s same-origin path', () => {
  const item = { id: 'it 1', files: [{ name: 'today.png', ref: 'figs/today.png', sha256: 'ab12', width: 4, height: 3 }] };
  const keys = reviewFileKeys('th/1', item);
  const want = { url: '/api/threads/th%2F1/items/it%201/files/today.png?sha=ab12', width: 4, height: 3 };
  assert.deepEqual({ ...keys }, { 'figs/today.png': want, 'today.png': want });
  assert.equal(reviewFileKeys('th_1', { id: 'it_1' }), undefined, 'none: the message stays as on main');
});

test('#780 a name wins over another file’s ref, and a file named __proto__ is an ordinary key', () => {
  const f = (name, ref, sha256) => ({ name, ref, sha256, width: 1, height: 1 });
  const keys = reviewFileKeys('th_1', { id: 'it_1', files: [f('x.png', 'b.png', 'aa'), f('b.png', 'c/b.png', 'bb'), f('__proto__', null, 'cc')] });
  assert.match(keys['b.png'].url, /files\/b\.png\?sha=bb$/);
  assert.ok(Object.hasOwn(keys, '__proto__'));
  assert.match(renderMarkdown('![x](__proto__)', { pageOrigin, files: keys }), /sha=cc/);
});

// #825 review: the alt text is agent content on the line where it becomes Postbox’s HTML, so every branch escapes it.
// Each hostile alt must come out as text: no raw quote, angle bracket or ampersand survives into the tag.
const hostileAlts = [
  ['a quote that ends the attribute', 'x" onerror="alert(1)', 'x&quot; onerror=&quot;alert(1)'],
  ['a tag', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['an entity', 'a &amp; b &#34;', 'a &amp;amp; b &amp;#34;'],
  ['a single quote', "x' onload='y", 'x&#39; onload=&#39;y'],
  ['non-ASCII and a long run', `“图” ${'é'.repeat(500)}`, `“图” ${'é'.repeat(500)}`],
];

for (const [what, alt, escaped] of hostileAlts) {
  test(`#825 an attached file’s alt with ${what} comes out escaped`, () => {
    const html = renderMarkdown(`![${alt}](a.png)`, { pageOrigin, files: { 'a.png': fig } });
    assert.ok(html.includes(`alt="${escaped}" width="640"`), html.slice(0, 300));
    assert.doesNotMatch(html, /onerror="|onload='|<script/);
  });

  test(`#825 a refused relative image’s alt with ${what} comes out escaped`, () => {
    const html = renderMarkdown(`![${alt}](b.png)`, { pageOrigin, files: { 'a.png': fig } });
    assert.ok(html.includes(`It shows: ${escaped}</span>`), html.slice(0, 300));
    assert.doesNotMatch(html, /<img|onerror="|onload='|<script/);
  });
}

test('#825 a hostile alt past the label limit stays text, escaped, with no image', () => {
  const html = renderMarkdown(`![${'x'.repeat(1200)}" onerror="alert(1)<b>](a.png)`, { pageOrigin, files: { 'a.png': fig } });
  assert.doesNotMatch(html, /<img|onerror="|<b>/);
  assert.match(html, /&quot; onerror=&quot;alert\(1\)&lt;b&gt;/);
});
