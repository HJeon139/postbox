// #405: a composer line `@handle /name args` runs that command for the agent it names, as `/name args` does for the
// agent the composer replies to (#67). shared/slash-line.mjs reads the line and decides which agent runs it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSlashLine, resolveCommand } from '../shared/slash-line.mjs';

test('parseSlashLine reads /name and @handle /name, and nothing else', () => {
  assert.deepEqual(parseSlashLine('/compact'), { handle: null, name: 'compact', rest: '', line: '/compact' });
  assert.deepEqual(parseSlashLine('  @developer /compact  '), { handle: 'developer', name: 'compact', rest: '', line: '/compact' });
  assert.deepEqual(parseSlashLine('@beta /release-notes 2.1'), { handle: 'beta', name: 'release-notes', rest: ' 2.1', line: '/release-notes 2.1' });
  assert.deepEqual(parseSlashLine('@a /plugin:review src/x.js\nmore'), {
    handle: 'a',
    name: 'plugin:review',
    rest: ' src/x.js\nmore',
    line: '/plugin:review src/x.js\nmore',
  });
  for (const text of ['hello', '@alpha please /compact', '@alpha', '@alpha/compact', 'see /tmp first', '@a @b /compact', '/', ''])
    assert.equal(parseSlashLine(text), null, text);
});

const alpha = { id: 'a', handle: 'alpha' };
const beta = { id: 'b', handle: 'beta' };
const gone = { id: 'g', handle: 'gone', archived: true };
const offered = { a: ['review'], b: ['release-notes'], g: ['review'] };
const at = (over = {}) => ({
  members: [alpha, beta, gone],
  reply: beta,
  own: ['compact', 'mode', 'stop'],
  has: (se, name) => offered[se.id].includes(name),
  ...over,
});

test('Postbox’s own command runs for the agent named, else the one the composer replies to', () => {
  assert.deepEqual(resolveCommand('@alpha /compact', at()), { own: true, name: 'compact', line: '/compact', se: alpha, named: alpha });
  assert.deepEqual(resolveCommand('@ALPHA /compact', at()).se, alpha, 'a handle in any case');
  assert.deepEqual(resolveCommand('/compact', at()), { own: true, name: 'compact', line: '/compact', se: beta, named: null });
  // With arguments it’s not Postbox’s, as before (#67): an agent that offers it runs it, else it’s a message.
  assert.equal(resolveCommand('@alpha /compact keep the plan', at()).missing, true);
});

test('an agent’s skill or command runs as the named agent’s turn, only if it offers it', () => {
  assert.deepEqual(resolveCommand('@beta /release-notes 2.1', at({ reply: alpha })), {
    own: false,
    name: 'release-notes',
    line: '/release-notes 2.1',
    se: beta,
    named: beta,
  });
  assert.deepEqual(resolveCommand('@alpha /release-notes', at()), { missing: true, name: 'release-notes', named: alpha });
  // An archived agent, or one not in the conversation, isn’t named: the line is a message.
  assert.equal(resolveCommand('@gone /review', at()), null);
  assert.equal(resolveCommand('@nobody /review', at()), null);
});

test('without an @handle: the / menu’s pick, then the reply target, then any agent that offers it', () => {
  assert.equal(resolveCommand('/review x', at({ pick: (name) => (name === 'review' ? beta : null) })).se, beta);
  assert.equal(resolveCommand('/review x', at()).se, alpha, 'beta doesn’t offer it, alpha does');
  assert.equal(resolveCommand('/review', at({ members: [beta, gone] })), null, 'only an archived agent offers it');
  assert.equal(resolveCommand('/unknown', at()), null);
});
