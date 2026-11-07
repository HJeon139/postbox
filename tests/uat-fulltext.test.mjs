// What the tester reads of a long item, and when it may approve one (tools/uat/fulltext.mjs). The items have the shape
// Postbox stores (server/runtime.mjs: an agent message is { kind: 'agent', sessionId, text }, a block is
// { kind: 'block', sessionId, revision, answered, block }), and the DESIGN-CHECK lines are the ones a UC03 round 3
// tester wrote (uat-runs/2026-10-27T22-17-15-uc03-attr3-terra-aiml/run.log, steps 9, 12 and 13).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approvalRefusal, fullView, readFull, recordText, SHOWN_CAP } from '../tools/uat/fulltext.mjs';

const design = (chars) => Array.from({ length: Math.ceil(chars / 50) }, (_, i) => `${String(i + 1).padStart(3, '0')} design line `.padEnd(49, '.')).join('\n');
const roomWith = (content, { answered = false } = {}) => ({
  items: {
    main: [
      { id: 'm1', kind: 'agent', sessionId: 's1', text: 'Here is the design for your review.' },
      {
        id: 'b1',
        kind: 'block',
        sessionId: 's1',
        revision: 3,
        answered,
        block: { type: 'review', id: 'design', title: 'Design v3', format: 'markdown', content },
      },
    ],
  },
});
const run = () => mkdtempSync(join(tmpdir(), 'uat-fulltext-'));
// The screen's innerText as the driver reads it: cut to 3,000 characters.
const screen = (state) => recordText(state.items.main[1]).slice(0, 3000);

test('a 10,000-character review waiting on the tester is shown whole, from Postbox’s record', () => {
  const state = roomWith(design(10_000));
  const cuts = new Map();
  const view = fullView({ key: 'b1', label: 'I3', screenText: screen(state), state, dir: run(), cuts });
  assert.equal(view.text, recordText(state.items.main[1]));
  assert.ok(view.text.includes('200 design line'), 'its last line is there');
  assert.ok(view.text.startsWith('Design v3') && view.text.includes('\n1: 001 design line'), 'its lines carry the numbers comments use');
  assert.equal(cuts.size, 0);
  assert.match(view.log, /I3 shown whole, \d+ characters/);
});

test('a long item not waiting on the tester is cut as before, but says so and names a file with all of it', () => {
  const state = roomWith(design(10_000), { answered: true });
  const dir = run();
  const cuts = new Map();
  const view = fullView({ key: 'b1', label: 'I3', screenText: screen(state), state, dir, cuts });
  const total = recordText(state.items.main[1]).length;
  assert.match(
    view.text,
    new RegExp(`\\(shown 1,800 of ${total.toLocaleString('en-US')} characters; full text: fulltext/I3-r3\\.md; read it with the read_full action on I3\\)$`),
  );
  assert.equal(readFileSync(join(dir, 'fulltext', 'I3-r3.md'), 'utf8'), recordText(state.items.main[1]));
  assert.deepEqual({ ...cuts.get('b1'), path: undefined, full: undefined }, { label: 'I3', shown: 1800, total, path: undefined, full: undefined });
});

test('a short design is shown as the screen shows it, with nothing added', () => {
  const state = roomWith('1. The models.\n2. The choices.');
  const dir = run();
  const shown = screen(state);
  assert.ok(shown.length < SHOWN_CAP);
  const view = fullView({ key: 'b1', label: 'I3', screenText: shown, state, dir, cuts: new Map() });
  assert.equal(view.text, shown);
  assert.equal(existsSync(join(dir, 'fulltext')), false);
  const answered = roomWith('1. The models.', { answered: true });
  assert.deepEqual(fullView({ key: 'b1', label: 'I3', screenText: screen(answered), state: answered, dir, cuts: new Map() }), {
    text: screen(answered),
    log: null,
  });
});

test('the agent message just before a waiting block is read whole too', () => {
  const state = roomWith('short');
  state.items.main[0].text = design(5_000);
  const view = fullView({ key: 'm1', label: 'I2', screenText: state.items.main[0].text.slice(0, 3000), state, dir: run(), cuts: new Map() });
  assert.equal(view.text, state.items.main[0].text);
});

test('an approval waits while the DESIGN-CHECK line marks an item unread or not visible', () => {
  const state = roomWith('short');
  const approve = { type: 'review', item: 'I3', verdict: 'approve' };
  const step9 = 'v2 restates the build. DESIGN-CHECK: 1 yes, 2 no (dropped in v2), 3 no (no models named), 4 yes, 5 unread.';
  const step12 = 'v3 covers the build. DESIGN-CHECK: 1 yes, 2 yes, 3 yes (per the builder; IDs not visible to me), 4 yes, 5 yes. Approving.';
  const step13 = 'The catalog check found the model unavailable. DESIGN-CHECK: 1 yes, 2 yes, 3 yes, 4 yes, 5 yes. Approving.';
  for (const assessment of [step9, step12])
    assert.match(approvalRefusal({ action: approve, assessment, key: 'b1', state, cuts: new Map() }), /marks an item as not read/);
  assert.equal(approvalRefusal({ action: approve, assessment: step13, key: 'b1', state, cuts: new Map() }), null);
  // Request changes is not an approval, and an answer to a block approves only in a step with a DESIGN-CHECK line.
  assert.equal(approvalRefusal({ action: { ...approve, verdict: 'request_changes' }, assessment: step9, key: 'b1', state, cuts: new Map() }), null);
  assert.equal(
    approvalRefusal({ action: { type: 'act', item: 'I3', button: 'Send choice' }, assessment: 'Picking the option.', key: 'b1', state, cuts: new Map() }),
    null,
  );
  assert.match(approvalRefusal({ action: { type: 'act', item: 'I3', button: 'Confirm' }, assessment: step12, key: 'b1', state, cuts: new Map() }), /not read/);
});

test('an approval waits while the block or its message was shown in part, until read_full reads it', () => {
  const state = roomWith(design(70_000));
  const dir = run();
  const cuts = new Map();
  fullView({ key: 'b1', label: 'I3', screenText: screen(state), state, dir, cuts });
  const approve = { type: 'review', item: 'I3', verdict: 'approve' };
  const allYes = 'DESIGN-CHECK: 1 yes, 2 yes, 3 yes, 4 yes, 5 yes.';
  assert.match(approvalRefusal({ action: approve, assessment: allYes, key: 'b1', state, cuts }), /shown 60,000 of [\d,]+ characters of I3/);
  const read = readFull({ key: 'b1', cuts, readText: (p) => readFileSync(p, 'utf8') });
  assert.ok(read.endsWith(recordText(state.items.main[1])));
  assert.equal(approvalRefusal({ action: approve, assessment: allYes, key: 'b1', state, cuts }), null);
  assert.match(readFull({ key: 'b1', cuts, readText: () => '' }), /nothing more to read/);
});

// Critic's review of ff21bb07: code and table blocks fell back to the screen's 3,000 characters and were logged whole;
// an answer without a DESIGN-CHECK line skipped the cut check; wider "unread" phrasing passed; and a design note that
// the model must not see something was refused.
test('a waiting code or table block is read from its record, and a screen cut the record can’t cover is marked', () => {
  const code = {
    items: { main: [{ id: 'b1', kind: 'block', sessionId: 's1', answered: false, block: { type: 'code', title: 'agent.py', code: 'x = 1\n'.repeat(800) } }] },
  };
  const view = fullView({ key: 'b1', label: 'I4', screenText: recordText(code.items.main[0]).slice(0, 3000), state: code, dir: run(), cuts: new Map() });
  assert.equal(view.text, recordText(code.items.main[0]));
  assert.ok(view.text.length > 4800, 'all 800 lines of code');
  const table = {
    items: {
      main: [
        {
          id: 'b1',
          kind: 'block',
          sessionId: 's1',
          answered: false,
          block: {
            type: 'table',
            title: 'T',
            columns: [{ id: 'a', label: 'A' }],
            rows: Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, cells: { a: `row ${i} value` } })),
          },
        },
      ],
    },
  };
  assert.ok(recordText(table.items.main[0]).includes('row 149 value'));
  const app = { items: { main: [{ id: 'b1', kind: 'block', sessionId: 's1', answered: false, block: { type: 'app', title: 'An app' } }] } };
  const cuts = new Map();
  const appView = fullView({ key: 'b1', label: 'I5', screenText: 'y'.repeat(3000), state: app, dir: run(), cuts });
  assert.match(appView.text, /shown 3,000 of more than 3,000 characters/);
  assert.ok(cuts.has('b1'));
});

test('any answer to a waiting block waits while it, or an item since the person’s last message, was shown in part', () => {
  const state = {
    items: {
      main: [
        { id: 'u1', kind: 'user', text: 'Please design it.' },
        { id: 'm0', kind: 'agent', sessionId: 's1', text: design(4_541) },
        { id: 'm1', kind: 'agent', sessionId: 's1', text: 'Choose a model.' },
        { id: 'b1', kind: 'block', sessionId: 's1', answered: false, block: { type: 'choice', title: 'Model', options: [{ id: 'a', label: 'A' }] } },
      ],
    },
  };
  const cuts = new Map();
  fullView({ key: 'm0', label: 'I2', screenText: state.items.main[1].text.slice(0, 3000), state, dir: run(), cuts });
  assert.match(approvalRefusal({ action: { type: 'act', item: 'I4', choose: ['A'] }, assessment: 'Picking A.', key: 'b1', state, cuts }), /I2/);
  // An item from before the person's last message doesn't hold up an answer.
  state.items.main.splice(2, 0, { id: 'u2', kind: 'user', text: 'Go on.' });
  assert.equal(approvalRefusal({ action: { type: 'act', item: 'I4', choose: ['A'] }, assessment: 'Picking A.', key: 'b1', state, cuts }), null);
});

test('the DESIGN-CHECK line is judged item by item: the tester’s own unread items wait, a design’s visibility rule doesn’t', () => {
  const state = roomWith('short');
  const approve = { type: 'review', item: 'I3', verdict: 'approve' };
  for (const note of [
    '5 not read yet',
    '4 yes (item 4 truncated)',
    '3 yes (IDs not fully visible)',
    '2 yes (cut off on my screen)',
    '1 partial',
    '5 incomplete',
  ])
    assert.match(approvalRefusal({ action: approve, assessment: `DESIGN-CHECK: ${note}, 2 yes.`, key: 'b1', state, cuts: new Map() }) ?? '', /not read/, note);
  const visibility = 'DESIGN-CHECK: 1 yes, 2 yes (the labels are not visible to the model, as the brief requires), 3 yes, 4 yes, 5 yes.';
  assert.equal(approvalRefusal({ action: approve, assessment: visibility, key: 'b1', state, cuts: new Map() }), null);
});

// Critic's re-review of 08738473: design wording inside a "yes" item ("partial credit", "incomplete records are
// dropped") refused a real approval. An item is unread only when it's a "no", or when the tester speaks for itself.
test('only a “no” item, or the tester’s own words about its reading, holds up an approval', () => {
  const state = roomWith('short');
  const approve = { type: 'review', item: 'I3', verdict: 'approve' };
  const ok = (line) => approvalRefusal({ action: approve, assessment: `DESIGN-CHECK: ${line}`, key: 'b1', state, cuts: new Map() });
  for (const line of [
    '1 yes, 2 yes (partial credit for a near-miss amount), 3 yes',
    '1 yes (incomplete records are dropped), 2 yes',
    '1 yes (labels not shown to the candidate)',
    '1 yes (not visible to the builder)',
  ])
    assert.equal(ok(line), null, line);
  for (const line of [
    '1 yes, 2 no (item 4 truncated)',
    '3 yes (IDs not visible to me)',
    '2 yes (I couldn’t see the table)',
    '5 unread',
    '4 yes (cut off on my screen)',
  ])
    assert.match(ok(line) ?? '', /not read/, line);
});

test('a cut permission can always be denied, and read_full explains when no full record exists', () => {
  const state = { items: { main: [{ id: 'b1', kind: 'permission', status: 'open' }] } };
  const cuts = new Map([['b1', { label: 'I3', shown: 3000, total: null, path: null, full: null }]]);
  const deny = { type: 'act', item: 'I3', button: 'Don’t allow' };
  assert.equal(approvalRefusal({ action: deny, assessment: 'I cannot read it, so I am denying it.', key: 'b1', state, cuts }), null);
  const read = readFull({ key: 'b1', cuts, readText: () => assert.fail('no path must not be read') });
  assert.match(read, /doesn’t hold the rest/);
  assert.equal(cuts.has('b1'), true, 'an unread cut remains unread');
  for (const button of ['Cancel the old jobs and deploy', 'Deny-list update: apply', 'Reject and publish'])
    assert.match(approvalRefusal({ action: { type: 'act', item: 'I3', button }, assessment: '', key: 'b1', state, cuts }), /shown/);
});

test('driver prefers the exact denial submit button over the earlier opener', async () => {
  const { byExactText } = await import('../tools/uat/selectors.mjs');
  const expr = byExactText('item', 'button', 'Don’t allow');
  assert.match(expr, /===/);
  assert.doesNotMatch(expr, /\.includes\(/);
  const driver = readFileSync(join(import.meta.dirname, '..', 'tools', 'uat', 'driver.mjs'), 'utf8');
  assert.match(driver, /byExactText[\s\S]*\?\?[^\n]*byText/);
});

test('read_full uses the in-memory Postbox record, not a builder-writable log file', () => {
  const state = roomWith(design(70_000));
  const dir = run();
  const cuts = new Map();
  fullView({ key: 'b1', label: 'I3', screenText: screen(state), state, dir, cuts });
  const cut = cuts.get('b1');
  writeFileSync(cut.path, 'builder replacement');
  const read = readFull({ key: 'b1', cuts, readText: (path) => readFileSync(path, 'utf8') });
  assert.ok(read.endsWith(recordText(state.items.main[1])));
  assert.doesNotMatch(read, /builder replacement/);
});

test('a denied cut permission no longer blocks a later readable approval', () => {
  const state = {
    items: {
      main: [
        { id: 'u1', kind: 'user', text: 'Proceed safely.' },
        { id: 'p1', kind: 'permission', status: 'denied' },
        { id: 'v1', kind: 'voice', text: 'The person did not allow this.' },
        { id: 'b2', kind: 'block', answered: false, block: { type: 'confirm' } },
      ],
    },
  };
  const cuts = new Map([['p1', { label: 'I2', shown: 3000, total: null, path: null, full: null }]]);
  const approve = { type: 'act', item: 'I4', button: 'Confirm' };
  assert.equal(approvalRefusal({ action: approve, assessment: '', key: 'b2', state, cuts }), null);
  state.items.main[1].status = 'open';
  assert.match(approvalRefusal({ action: approve, assessment: '', key: 'b2', state, cuts }), /I2/);
  state.items.main[1].status = 'expired';
  assert.equal(approvalRefusal({ action: approve, assessment: '', key: 'b2', state, cuts }), null);
  for (const status of ['canceled', 'ended', 'allowed', 'allowed-always', 'allowed-edited']) {
    state.items.main[1].status = status;
    assert.equal(approvalRefusal({ action: approve, assessment: '', key: 'b2', state, cuts }), null, status);
  }
  state.items.main.splice(1, 0, { id: 'a1', kind: 'agent', text: 'cut agent message' });
  cuts.set('a1', { label: 'I1', shown: 1800, total: 5000, path: '/unused', full: 'x'.repeat(5000) });
  state.items.main[2].status = 'denied';
  assert.match(approvalRefusal({ action: approve, assessment: '', key: 'b2', state, cuts }), /I1/);
});

test('only the denial opener that remains open is handed back for its submit action', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'tools', 'uat-run.mjs'), 'utf8');
  assert.match(source, /a\.button === 'Don’t allow…'/);
  assert.match(source, /attempt < 4/);
  assert.match(source, /await sleep\(500\)/);
  assert.match(source, /current\?\.kind === 'permission' && current\.status === 'open'/);
  assert.match(source, /told\.delete\(key\)/);
  assert.match(source, /no answer was sent/);
});
