// #780 on a host: a review block’s files come from the host’s broker as { name, path, base64 } (note as_BkHPLMds v3,
// §2, “Remote hosts”), and the laptop stores them through the same checks as a local agent’s (storeReviewFiles):
// type and dimensions by content, the ref kept from the path. The base64 is bounded by its length and alphabet
// before Postbox decodes it, so a host can’t make Postbox decode more than one image’s worth.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onTool } from '../server/remote/turns-tools.mjs';
import { REVIEW_IMAGES } from '../shared/limits.mjs';
import { png, reviewBlock, setup } from './review-files-fixture.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

/** Applies one call from a host, as server/remote/turns.mjs does, from inside the agent’s turn; gives the reply. */
async function fromHost(f, name, args) {
  return f.during(async () => {
    const replies = [];
    const rts = {
      rt: f.rt,
      byTurn: new Map([['t_host', { sessionId: f.se.id, rt: f.rt.turns.get(f.se.id) }]]),
      needed: new Map([
        [
          'host_1',
          {
            link: {
              send: (m) => {
                replies.push(m);
                return true;
              },
            },
          },
        ],
      ]),
      applying: new Set(),
      restoring: new Map(),
      now: () => 1000,
    };
    await onTool(/** @type {any} */ (rts), 'host_1', { turn: 't_host', id: `c_${Math.random()}`, name, args });
    return replies[0];
  });
}

test('#780 a host’s base64 review file is stored as a local one is: type, dimensions and the ref from its path', async () => {
  const f = await setup();
  const r = await fromHost(f, 'show_block', reviewBlock('fig', [{ name: 'today.png', path: 'figs/today.png', base64: png(640, 480).toString('base64') }]));
  assert.equal(r.ok, true, r.text);
  const [kept] = f.review('fig').files;
  assert.deepEqual(
    { ...kept, sha256: typeof kept.sha256 },
    { name: 'today.png', ref: 'figs/today.png', sha256: 'string', size: png(640, 480).length, type: 'image/png', width: 640, height: 480 },
  );
  assert.deepEqual(await f.rt.blobs.get(kept.sha256), png(640, 480));
  const u = await fromHost(f, 'update_block', reviewBlock('fig', [{ name: 'today.png', path: './figs/today.png', base64: png(8, 8).toString('base64') }]));
  assert.equal(u.ok, true, u.text);
  assert.deepEqual(
    f.review('fig').files.map((x) => [x.ref, x.width]),
    [[null, 8]],
    'an update’s files replace the list; a path that isn’t plain keeps no ref',
  );
});

test('#780 a host’s SVG, or HTML named .png, is refused naming the four types, and nothing is shown', async () => {
  const f = await setup();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  for (const [name, body] of [
    ['a.svg', svg],
    ['b.png', '<html><script>x()</script></html>'],
  ]) {
    const r = await fromHost(f, 'show_block', reviewBlock(`x-${name}`, [{ name, path: `figs/${name}`, base64: b64(body) }]));
    assert.equal(r.ok, false, name);
    assert.match(r.text, /PNG, JPEG, GIF or WebP/, name);
    assert.equal(f.review(`x-${name}`), undefined, name);
  }
});

test('#780 a host’s base64 one block over an image’s limit is refused before Postbox decodes it', async () => {
  const f = await setup();
  const at = 4 * Math.ceil(REVIEW_IMAGES.reviewImageBytes / 3);
  const over = 'A'.repeat(at + 4);
  const decoded = [];
  const from = Buffer.from;
  Buffer.from = function (...a) {
    if (a[0] === over) decoded.push(a[1]);
    return from.apply(Buffer, a);
  };
  let r;
  try {
    r = await fromHost(f, 'show_block', reviewBlock('big', [{ name: 'big.png', path: 'big.png', base64: over }]));
  } finally {
    Buffer.from = from;
  }
  assert.equal(r.ok, false);
  assert.equal(r.text, 'The image “big.png” (up to 5 MiB) is over its limit as it came from the host, so Postbox didn’t read it.');
  assert.deepEqual(decoded, [], 'never decoded');
  assert.equal(f.review('big'), undefined);
  // At the length, it still decodes to more than the limit (3 bytes a block): refused once decoded.
  const just = await fromHost(f, 'show_block', reviewBlock('just', [{ name: 'just.png', path: 'just.png', base64: 'A'.repeat(at) }]));
  assert.equal(just.text, 'The image “just.png” (up to 5 MiB) is over its limit as it came from the host, so Postbox didn’t read it.');
});

test('#780 a host’s base64 with a character outside the alphabet, an = anywhere but its last one or two, or a length not a multiple of 4, is refused', async () => {
  const f = await setup();
  const good = png(4, 3).toString('base64');
  for (const [i, base64] of [
    `${good.slice(0, -4)}AA!A`,
    `${good.slice(0, -4)}AAA`,
    `${good.slice(0, 4)}=${good.slice(5)}`,
    'ab=c',
    '=AAA',
    'A===',
    `${good.slice(0, -4)}AA==AAAA`,
    7,
  ].entries()) {
    const r = await fromHost(f, 'show_block', reviewBlock(`bad${i}`, [{ name: 'a.png', path: 'a.png', base64 }]));
    assert.equal(r.ok, false, String(base64).slice(0, 20));
    assert.equal(r.text, 'The image “a.png” (up to 5 MiB) didn’t arrive whole from the host, so Postbox didn’t read it.');
    assert.equal(f.review(`bad${i}`), undefined);
  }
});

test('#780 a local turn can’t hand Postbox base64: a file with no path is refused, and nothing is stored', async () => {
  const f = await setup();
  const r = await f.call('show_block', reviewBlock('fig', [{ name: 'today.png', base64: png(4, 3).toString('base64') }]));
  assert.equal(r.isError, true);
  assert.equal(r.text, 'the image “today.png” (up to 5 MiB) needs a path to a file in your folder.');
  assert.equal(f.review('fig'), undefined);
});

test('#780 a host’s refused review call is answered to the agent that waits for it, not told again at its next turn', async () => {
  const f = await setup();
  const told = [];
  const tell = f.rt.tellAgent.bind(f.rt);
  f.rt.tellAgent = (sessionId, text) => {
    told.push(text);
    return tell(sessionId, text);
  };
  const r = await fromHost(f, 'show_block', reviewBlock('svg', [{ name: 'a.png', path: 'a.png', base64: Buffer.from('<svg/>').toString('base64') }]));
  assert.equal(r.ok, false);
  assert.match(r.text, /PNG, JPEG, GIF or WebP/);
  assert.deepEqual(
    told.filter((t) => /didn’t go through/.test(t)),
    [],
    'it waited for this answer (toolRoute), so no note follows',
  );
});
