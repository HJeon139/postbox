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
const gone = { id: 'g', handle: 'gone', retiredFork: true };
const offered = { a: ['review', 'compact'], b: ['release-notes'], g: ['review'] };
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
});

// #546: `/effort low` went to the agent as a message and started a paid turn, with nothing said before it was sent.
test('Postbox’s own command with an argument runs without it if it only opens a view, else is refused', () => {
  const views = ['mode'];
  assert.deepEqual(resolveCommand('/mode ask', at({ views })), { own: true, name: 'mode', line: '/mode', se: beta, named: null, dropped: 'ask' });
  assert.deepEqual(resolveCommand('@alpha /mode ask', at({ views })).se, alpha, 'for the agent named');
  // /stop alpha run as /stop would stop every agent: it’s refused, and nothing is sent.
  assert.deepEqual(resolveCommand('/stop alpha', at({ views })), { refused: true, name: 'stop', se: beta, named: null, dropped: 'alpha' });
  assert.equal(resolveCommand('/compact keep the plan', at({ views, members: [beta] })).refused, true);
  assert.equal(resolveCommand('@ghost /mode ask', at({ views })).missing, 'agent', 'a handle no agent here has, as before');
  // An agent that offers a command of that name still gets it with its argument, the one named or any here (#67).
  assert.deepEqual(resolveCommand('@alpha /compact keep the plan', at({ views })).line, '/compact keep the plan');
  const theirs = resolveCommand('/compact keep the plan', at({ views }));
  assert.deepEqual([theirs.se, theirs.shadows], [alpha, true], 'beta doesn’t offer it, alpha does, and the composer says so');
  assert.equal(resolveCommand('@alpha /compact keep the plan', at({ views })).shadows, undefined, 'named, it says so already');
  // With files, the composer sends the line with them as a message unless it’s refused: so a dropped argument is refused,
  // and no agent’s turn is promised.
  assert.deepEqual(resolveCommand('/mode ask', at({ views, files: true })), { refused: true, name: 'mode', se: beta, named: null, dropped: 'ask' });
  assert.equal(resolveCommand('/compact keep the plan', at({ views, files: true })).shadows, undefined);
});

test('an agent’s skill or command runs as the named agent’s turn, only if it offers it', () => {
  assert.deepEqual(resolveCommand('@beta /release-notes 2.1', at({ reply: alpha })), {
    own: false,
    name: 'release-notes',
    line: '/release-notes 2.1',
    se: beta,
    named: beta,
  });
  assert.deepEqual(resolveCommand('@alpha /release-notes', at()), { missing: 'command', name: 'release-notes', named: alpha, handle: 'alpha' });
  // A retired fork, or an agent not in the conversation, isn’t named: the line is a message, and the hint says so.
  assert.deepEqual(resolveCommand('@gone /review', at()), { missing: 'agent', name: 'review', named: null, handle: 'gone' });
  assert.deepEqual(resolveCommand('@ghost /compact', at()), { missing: 'agent', name: 'compact', named: null, handle: 'ghost' });
});

test('without an @handle: the / menu’s pick, then the reply target, then any agent that offers it', () => {
  assert.equal(resolveCommand('/review x', at({ pick: (name) => (name === 'review' ? beta : null) })).se, beta);
  assert.equal(resolveCommand('/review x', at()).se, alpha, 'beta doesn’t offer it, alpha does');
  assert.equal(resolveCommand('/review', at({ members: [beta, gone] })), null, 'only a retired fork offers it');
  assert.equal(resolveCommand('/unknown', at()), null);
});
