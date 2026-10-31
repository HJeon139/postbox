// #296: the repository a push the person asks for goes to is theirs to set on the project, in Settings. Postbox makes
// that push itself, so it takes only a repository it can push to, never another transport or an option.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setPushUrl } from '../server/projects.mjs';
import { Store } from '../server/store.mjs';

test('a project takes an https or ssh repository, or a folder, and empty clears it', () => {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/x' });
  for (const url of ['https://github.com/HJeon139/postbox.git', 'git@github.com:HJeon139/postbox.git', 'ssh://git@host/repo.git', '/Users/me/remote.git']) {
    setPushUrl(store, 'p1', ` ${url} `);
    assert.equal(store.state.projects.p1.pushUrl, url);
  }
  setPushUrl(store, 'p1', '');
  assert.equal('pushUrl' in store.state.projects.p1, false);
  for (const url of [
    'ext::sh -c touch% /tmp/x',
    '--upload-pack=touch /tmp/x',
    'file:///x',
    'http://plain.example/x',
    'git@host:-oProxyCommand=x',
    'relative/path',
    'https://host/a b',
  ])
    assert.throws(() => setPushUrl(store, 'p1', url), /isn’t a repository Postbox can push to/, url);
  assert.throws(() => setPushUrl(store, 'nope', 'https://github.com/a/b'), /doesn’t exist/);
});
