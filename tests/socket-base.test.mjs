import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostSocketBase, SUN_PATH_BYTES, socketBase } from './socket-base.mjs';

/** The longest socket path a fixture builds under its folder: here, 60 bytes past it. */
const longest = (/** @type {string} */ dir) => `${dir}/${'s'.repeat(59)}`;

test('a fixture’s folder goes under TMPDIR when its longest socket path fits there', () => {
  assert.equal(socketBase('pbr-', longest, { env: { TMPDIR: '/tmp/pb-gate-1-AbC123' }, platform: 'linux' }), '/tmp/pb-gate-1-AbC123');
});

test('a fixture’s folder falls back to /tmp when TMPDIR would push its longest socket path past the limit', () => {
  const deep = `${['', 'var', 'folders'].join('/')}/${'x'.repeat(30)}/T`; // macOS’s deep temp folder, joined so this file holds no such path
  assert.equal(socketBase('pbr-', longest, { env: { TMPDIR: deep }, platform: 'linux' }), '/tmp');
});

test('the limit is 104 bytes with the terminating NUL on macOS and 108 on Linux', () => {
  assert.deepEqual(SUN_PATH_BYTES, { darwin: 104, linux: 108 });
  const at = (/** @type {number} */ bytes) => `/${'t'.repeat(bytes - 1 - '/pbr-XXXXXX/'.length - 59)}`;
  const env = (/** @type {number} */ bytes) => ({ TMPDIR: at(bytes) });
  assert.equal(socketBase('pbr-', longest, { env: env(103), platform: 'darwin' }), at(103), '103 bytes fit on macOS');
  assert.equal(socketBase('pbr-', longest, { env: env(104), platform: 'darwin' }), '/tmp', '104 don’t, with the NUL');
  assert.equal(socketBase('pbr-', longest, { env: env(107), platform: 'linux' }), at(107), '107 bytes fit on Linux');
  assert.equal(socketBase('pbr-', longest, { env: env(108), platform: 'linux' }), '/tmp', '108 don’t');
});

test('a fixture’s folder goes under /tmp when TMPDIR is unset, empty or relative', () => {
  for (const TMPDIR of [undefined, '', 'tmp']) assert.equal(socketBase('pbr-', longest, { env: { TMPDIR }, platform: 'linux' }), '/tmp', String(TMPDIR));
});

test('a trailing slash on TMPDIR is dropped', () => {
  assert.equal(socketBase('pbr-', longest, { env: { TMPDIR: '/tmp/run/' }, platform: 'linux' }), '/tmp/run');
});

test('a host home’s longest socket is a turn’s with the longest turn ID, so a gate run’s TMPDIR fits and a deep one doesn’t', () => {
  assert.equal(hostSocketBase('pbr-', '', { env: { TMPDIR: '/tmp/pb-gate-12345-AbC123' }, platform: 'linux' }), '/tmp/pb-gate-12345-AbC123');
  assert.equal(hostSocketBase('pbr-', '', { env: { TMPDIR: `/tmp/${'d'.repeat(30)}` }, platform: 'linux' }), '/tmp');
});
