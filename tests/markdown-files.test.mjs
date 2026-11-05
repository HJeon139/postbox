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
