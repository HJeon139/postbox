// #991: a path on a host (a project’s folder there, or a program’s path in the host’s settings) refuses what a
// project’s folder on this computer refuses (#547): any control character, C1 included, a lone surrogate, and the
// characters that hide or reorder text (shared/invisible.mjs), except ZWNJ and ZWJ, which join letters and emoji.
// One rule, checkHostPath, serves the page’s host sheets, the server and the host’s daemon.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { searchFolders } from '../server/remote/host/programs.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { hostPath } from '../shared/remote-protocol-checks.mjs';
import { checkHostPath, checkHostSettings } from '../shared/remote-settings.mjs';

/** The refusals, naming the path as checkHostPath’s `what`. @param {string} what */
const control = (what) => `${what} can’t contain control characters, such as a new line.`;
/** @param {string} what */
const hidden = (what) => `${what} can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate.`;
const CONTROL = control('folder');
const HIDDEN = hidden('folder');

// Each character, put inside a path as /tmp/a<c>b, and the error it hears, or '' where the path is taken.
const CASES = [
  ['"', ''],
  ['<', ''],
  ['&', ''],
  ['\u0000', CONTROL],
  ['\u0085', CONTROL],
  ['\u009b', CONTROL],
  ['\u202e', HIDDEN],
  ['\u2066', HIDDEN],
  ['\u200b', HIDDEN],
  ['\ufeff', HIDDEN],
  ['\u3164', HIDDEN],
  ['\ufe0f', HIDDEN],
  ['\u{e0041}', HIDDEN],
  ['\ud800', HIDDEN],
  ['\udc00', HIDDEN],
  ['\u200c', ''],
  ['\u200d', ''],
  ['é', ''],
  ['日本', ''],
];

const name = (c) => `U+${[...c].map((x) => /** @type {number} */ (x.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0')).join(' U+')}`;

test('#991 a path on a host refuses every control character, a lone surrogate and an invisible character, and takes ZWNJ and ZWJ', () => {
  for (const [c, error] of CASES) {
    const path = `/tmp/a${c}b`;
    const r = checkHostPath(path, 'folder');
    assert.deepEqual(r, error ? { ok: false, error } : { ok: true, value: path }, name(c));
  }
});

test('#991 a path on a host takes an emoji joined with ZWJ and a word joined with ZWNJ', () => {
  for (const path of ['/home/me/👨\u200d👩\u200d👧', '/srv/نامه\u200cها']) assert.deepEqual(checkHostPath(path, 'folder'), { ok: true, value: path });
});

test('#991 a host’s project folder with a bidi override is refused with a 422 and isn’t stored', () => {
  const store = new Store(null);
  const adapter = { name: 'mock', deliver: async () => {} };
  const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
  const rt = new Runtime({ store, adapters: new AdapterRegistry().register(adapter), corpus, config: { origin: 'http://127.0.0.1:1', imageOrigins: [] } });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const h = rt.addHost({ name: 'devbox' });
  rt.setProjectHostFolder('p1', h.id, '/srv/app');
  assert.throws(
    () => rt.setProjectHostFolder('p1', h.id, '/tmp/a\u202ebc'),
    (e) => e.status === 422 && e.message === hidden('The project’s folder on devbox'),
  );
  assert.deepEqual(rt.s.projects.p1.hostFolders, { [h.id]: '/srv/app' }, 'the folder before is kept');
});

test('#991 a program’s path in a host’s settings with a C1 control or a bidi isolate is refused', () => {
  assert.deepEqual(checkHostSettings({ claudePath: '/usr/bin/cl\u0085aude' }), { ok: false, error: control('claudePath') });
  assert.deepEqual(checkHostSettings({ nodePath: '/usr/bin/\u2066node' }), { ok: false, error: hidden('nodePath') });
});

test('#991 a host path in a protocol message, such as start.folder, is refused by the same rule', () => {
  assert.equal(hostPath('/srv/a\u202ebc', 'start.folder'), hidden('start.folder'));
  assert.equal(hostPath('/srv/a\u200cb', 'start.folder'), '');
});

test('#991 the host’s daemon doesn’t look for a harness in a PATH folder with a C1 control or a bidi override', async () => {
  const dirs = await searchFolders('/home/me', '/opt/a\u0085b:/opt/c\u202ed:/opt/\u200cok:/opt/plain', async () => []);
  assert.deepEqual(dirs.slice(0, 2), ['/opt/\u200cok', '/opt/plain']);
  assert.equal(dirs.filter((d) => d.startsWith('/opt/')).length, 2);
});
