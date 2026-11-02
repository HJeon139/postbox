// read_message on an app gives its code, in parts, pinned to a version (#516's S1, AP-1's tool half; #417): another
// agent can judge an app from its code, not only from its author's summary. `from` counts characters of the code alone,
// so a browser check recorded between parts, which changes the head line, doesn't move where a part starts. Every
// "reads on" line names the version, so an update_app between parts doesn't change what the next part reads.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READING } from '../shared/limits.mjs';
import { setup } from './side-threads-fixture.mjs';

/** 100,000 characters of HTML whose every line names its place, so a part read twice or skipped shows. */
const BIG = (tag) =>
  Array.from({ length: 10_000 }, (_, i) => `<i>${tag}${String(i).padStart(4, '0')}</i>\n`)
    .join('')
    .slice(0, 100_000);

/** The code between a part's fences. @param {string} msg */
function codeOf(msg) {
  const m = msg.match(/\n(`{3,})html\n([\s\S]*?)\n?\1(?:\n|$)/);
  assert.ok(m, `a fenced code block in: ${msg.slice(0, 300)}`);
  return m[2];
}
/** The arguments a part's "reads on" line gives, or null on the last part. @param {string} msg */
function readsOn(msg) {
  const m = msg.match(/read_message (\{[^}]*\}) reads on\./);
  return m ? JSON.parse(m[1].replace(/(\w+):/g, '"$1":')) : null;
}

function withApp(code) {
  const r = setup();
  const tools = r.rt.toolsFor(r.alpha.id);
  const shown = tools.show_app({ id: 'lab', title: 'Lab', code });
  assert.notEqual(shown.ok, false, JSON.stringify(shown));
  const read = (args) => {
    const res = r.rt.readMessage(r.beta, args);
    assert.equal(res.ok, true, res.message);
    return res.message;
  };
  return { ...r, tools, read };
}

test('#516 S1: an agent reads a 100,000-character app in three parts by following each "reads on" line, and an update between parts changes nothing', () => {
  const v1 = BIG('a');
  const { tools, read } = withApp(v1);
  const one = read({ id: 'lab' });
  assert.match(one, /App lab, v1\. Browser check: pending\./);
  assert.match(one, /@alpha/, 'the head names the app’s author');
  assert.equal(codeOf(one).length, READING.part);
  const at2 = readsOn(one);
  assert.equal(at2.version, 1, 'the "reads on" line names the version');
  assert.equal(at2.from, READING.part);
  assert.match(one, /Characters 1–40,000 of 100,000/, 'N counts the code alone');
  // A new version between parts: the pinned reads go on reading v1.
  assert.notEqual(tools.update_app({ id: 'lab', code: BIG('b') }).ok, false);
  const two = read(at2);
  assert.match(two, /App lab, v1/, 'every part repeats the head');
  const three = read(readsOn(two));
  assert.equal(readsOn(three), null, 'the last part has no "reads on"');
  assert.match(three, /Characters 80,001–100,000 of 100,000/);
  assert.equal(codeOf(one) + codeOf(two) + codeOf(three), v1, 'the three parts are v1’s code, whole, once');
});

test('#516 S1: a browser check recorded between parts doesn’t move where parts 2 and 3 start', () => {
  const v1 = BIG('c');
  const { rt, read } = withApp(v1);
  const one = read({ id: 'lab' });
  // The head grows by the problem's line.
  rt.appCheck('lab', { version: 1, problems: [{ code: 'overflow', message: 'The page scrolls sideways at 375 px.' }] });
  const two = read(readsOn(one));
  assert.match(two, /- overflow: The page scrolls sideways at 375 px\./, 'the head grew by the problem');
  const three = read(readsOn(two));
  assert.equal(codeOf(one) + codeOf(two) + codeOf(three), v1);
});

test('#516 S1: read_message { id, version: 1 } on a v3 app gives v1’s code and says its check isn’t kept; a version it doesn’t have is refused', () => {
  const { rt, tools, read } = withApp('<p>one</p>');
  tools.update_app({ id: 'lab', code: '<p>two</p>' });
  tools.update_app({ id: 'lab', code: '<p>three</p>' });
  const old = read({ id: 'lab', version: 1 });
  assert.equal(codeOf(old), '<p>one</p>');
  assert.match(old, /v1/);
  assert.match(old, /isn’t kept/);
  assert.doesNotMatch(old, /Browser check: pending/, 'v3’s check isn’t given as v1’s');
  assert.equal(codeOf(read({ id: 'lab' })), '<p>three</p>', 'without a version, the current one');
  const none = rt.readMessage(rt.sessionsIn(Object.keys(rt.s.threads)[0])[1], { id: 'lab', version: 9 });
  assert.equal(none.ok, false);
  assert.match(none.message, /v3/, 'the refusal names the newest version');
});

test('#516 S1: from past 0 with no version reads the current version, and names it', () => {
  const { tools, read } = withApp(BIG('d'));
  tools.update_app({ id: 'lab', code: BIG('e') });
  const part = read({ id: 'lab', from: READING.part });
  assert.match(part, /App lab, v2/);
  assert.equal(readsOn(part).version, 2);
  assert.equal(codeOf(part), BIG('e').slice(READING.part, 2 * READING.part));
});
