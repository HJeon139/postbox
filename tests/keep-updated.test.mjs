// What a host’s card and a turn’s status line say of its newest automatic install (app/js/keep-updated.mjs, #464-b2b),
// from the host’s status as server/remote/host-status.mjs sends it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { installingVersion, updateShown } from '../app/js/keep-updated.mjs';

const at = 1_700_000_000_000;
/** A host’s status with its newest automatic install. @param {string | null} state @param {any} update */
const status = (state, update) => ({ state, failure: null, welcome: null, lastHeard: null, keepUpdated: true, update });

test('#464 an install under way reads as installing while the host isn’t connected', () => {
  assert.equal(updateShown(status('failed', { version: '0.18.0', at, outcome: 'started' })), 'installing');
});

test('#464 an install under way says nothing once the host is connected', () => {
  assert.equal(updateShown(status('connected', { version: '0.18.0', at, outcome: 'started' })), null);
});

test('#464 an install that installed the version reads as installed, connected or not', () => {
  assert.equal(updateShown(status('connected', { version: '0.18.0', at, outcome: 'installed' })), 'installed');
  assert.equal(updateShown(status('reconnecting', { version: '0.18.0', at, outcome: 'installed' })), 'installed');
});

test('#464 a failed install reads as failed while the host isn’t connected', () => {
  assert.equal(updateShown(status('failed', { version: '0.18.0', at, outcome: 'failed' })), 'failed');
});

test('#464 a failed install says nothing once the host is connected', () => {
  assert.equal(updateShown(status('connected', { version: '0.18.0', at, outcome: 'failed' })), null);
});

test('#464 a note of installs that couldn’t be read or written reads as failed, whatever the newest install says', () => {
  const error = 'Postbox couldn’t read its note of installs on this host, so it won’t install by itself.';
  assert.equal(updateShown(status('failed', { version: null, at: null, outcome: null, error })), 'failed');
  assert.equal(updateShown(status('failed', { version: '0.18.0', at, outcome: 'installed', error })), 'failed');
  assert.equal(updateShown(status('failed', { version: '0.18.0', at, outcome: 'started', error })), 'failed');
});

test('#464 busy and present say nothing on the card', () => {
  for (const outcome of ['busy', 'present']) assert.equal(updateShown(status('failed', { version: '0.18.0', at, outcome })), null, outcome);
});

test('#464-b3 an install that made a new token reads as reinstalled while the host is connected, and as nothing after', () => {
  const soon = at + 60_000;
  assert.equal(updateShown(status('connected', { version: '0.18.0', at, outcome: 'reinstalled' }), soon), 'reinstalled');
  assert.equal(updateShown(status('not-installed', { version: '0.18.0', at, outcome: 'reinstalled' }), soon), null, 'its folder gone again');
});

test('#464-b3 “reinstalled” says so for a day, then nothing: by then it’s old news, not a warning', () => {
  const u = { version: '0.18.0', at, outcome: 'reinstalled' };
  assert.equal(updateShown(status('connected', u), at + 23 * 3_600_000), 'reinstalled');
  assert.equal(updateShown(status('connected', u), at + 25 * 3_600_000), null);
});

test('#464 a host with no automatic install, or no status, says nothing', () => {
  assert.equal(updateShown(status('failed', null)), null);
  assert.equal(updateShown(null), null);
  assert.equal(updateShown(undefined), null);
});

test('#464 the version being installed is the install’s while it reads as installing, else null', () => {
  assert.equal(installingVersion(status('failed', { version: '0.18.0', at, outcome: 'started' })), '0.18.0');
  assert.equal(installingVersion(status('connected', { version: '0.18.0', at, outcome: 'started' })), null);
  assert.equal(installingVersion(status('failed', { version: '0.18.0', at, outcome: 'installed' })), null);
  assert.equal(installingVersion(null), null);
});
