// #991: an uploaded file’s name (POST /api/files, its x-filename header) shows in its attachment chip, so each control
// character, lone surrogate and character that hides or reorders text becomes “_”, as \ and / do, rather than the
// upload being refused: the file is the person’s, and its name is only shown. ZWNJ and ZWJ stay, as a folder keeps
// them (#547). The name is cut at 200 characters, never between the two halves of a surrogate pair.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fakeRequest, NAVIGATION } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4491;
let app;
const call = (r) => fakeRequest(app.handle, { host: `127.0.0.1:${PORT}`, ...r });

before(async () => {
  const dir = tempDir('pb-upload-name-');
  app = await start({ port: PORT, dataDir: dir, fresh: true, demo: false, quiet: true, claudeHome: dir, listen: false });
});
after(() => app.close());

/** Uploads a few bytes under the x-filename header the page sends, and returns the name kept, after checking it’s stored so. */
async function uploaded(header) {
  const cookie = (await call({ path: '/', headers: NAVIGATION })).headers['set-cookie'].split(';')[0];
  const r = await call({ method: 'POST', path: '/api/files', body: 'x', cookie, headers: { 'x-filename': header, 'content-type': 'text/plain' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(app.store.state.files[r.json.id].name, r.json.name, 'the stored name is the one answered');
  return r.json.name;
}

// Each name as the person’s file had it, and the name kept.
const CASES = [
  ['a"<&b.txt', 'a"<&b.txt'],
  ['a\\b/c.txt', 'a_b_c.txt'],
  ['a\u0000b.txt', 'a_b.txt'],
  ['a\u0085b.txt', 'a_b.txt'],
  ['report\u202efdp.exe', 'report_fdp.exe'],
  ['a\u2066b\u2069.txt', 'a_b_.txt'],
  ['a\u200bb.txt', 'a_b.txt'],
  ['\ufeffa.txt', '_a.txt'],
  ['a\u3164b.txt', 'a_b.txt'],
  ['a\ufe0fb.txt', 'a_b.txt'],
  ['a\u{e0041}b.txt', 'a_b.txt'],
  ['نامه\u200cها.txt', 'نامه\u200cها.txt'],
  ['👨\u200d👩\u200d👧.png', '👨\u200d👩\u200d👧.png'],
  ['résumé.pdf', 'résumé.pdf'],
  ['日本.txt', '日本.txt'],
];

test('#991 an upload’s name keeps what shows, and has each control, invisible or bidi character as “_”', async () => {
  for (const [name, kept] of CASES) assert.equal(await uploaded(encodeURIComponent(name)), kept, JSON.stringify(name));
});

test('an upload with an empty name, or none, is kept as “file”', async () => {
  assert.equal(await uploaded(''), 'file');
  assert.equal(await uploaded(encodeURIComponent('')), 'file');
});

test('#991 an upload’s name sent unencoded, with a C1 control in the header, has it as “_”', async () => {
  assert.equal(await uploaded('a\u0085b.txt'), 'a_b.txt');
});

test('#991 an upload’s name is cut at 200 characters without leaving half of a surrogate pair', async () => {
  const name = await uploaded(encodeURIComponent(`${'a'.repeat(199)}😀b.txt`));
  assert.equal(name, 'a'.repeat(199));
  assert.ok(name.isWellFormed(), 'no lone surrogate');
  assert.equal(await uploaded(encodeURIComponent(`${'a'.repeat(198)}😀b.txt`)), `${'a'.repeat(198)}😀`);
});
