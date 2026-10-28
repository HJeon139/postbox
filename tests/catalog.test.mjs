import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG, validateBlock } from '../shared/catalog.mjs';

const base = (type, extra) => ({ id: 'b1', type, version: 1, fallback: 'Plain text version.', ...extra });
const ok = (b, opts) => {
  const r = validateBlock(b, opts);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r;
};
const bad = (b, re, opts) => {
  const r = validateBlock(b, opts);
  assert.equal(r.ok, false, 'expected the block to be rejected');
  if (re)
    assert.ok(
      r.errors.some((e) => re.test(e)),
      `no error matched ${re}: ${JSON.stringify(r.errors)}`,
    );
  return r;
};

test('accepts one valid block of every type in the catalog', () => {
  const blocks = [
    base('choice', {
      title: 'When?',
      options: [
        { id: 'w', label: 'Weekly' },
        { id: 'd', label: 'Daily' },
      ],
      other: { label: 'Something else' },
    }),
    base('form', {
      fields: [
        { id: 'n', label: 'Name', kind: 'text', required: true },
        { id: 'p', label: 'Pace', kind: 'select', options: [{ id: 's', label: 'Steady' }] },
        { id: 'x', label: 'Notes', kind: 'longtext' },
      ],
    }),
    base('table', {
      columns: [
        { id: 'book', label: 'Book' },
        { id: 'n', label: 'Count', kind: 'number', sortable: true },
      ],
      rows: [{ id: 'r1', cells: { book: 'Emma', n: 3 } }],
      rowAction: { id: 'open', label: 'Open' },
    }),
    base('progress', { steps: [{ id: 's1', label: 'Index', state: 'running' }] }),
    base('card', { facts: [{ label: 'Author', value: 'George Eliot' }], actions: [{ id: 'a', label: 'Open' }] }),
    base('confirm', { statement: 'This removes 14 passages.', confirmLabel: 'Remove 14 passages' }),
    base('image', { src: 'https://www.gutenberg.org/cover.jpg', alt: 'A title page' }),
    base('code', { code: 'const x = 1;', language: 'js' }),
    base('review', { format: 'markdown', content: '# Spec' }),
    base('app', { code: '<p>Hi</p>', permissions: ['corpus.search'] }),
  ];
  assert.equal(blocks.length, Object.keys(CATALOG).length);
  for (const b of blocks) ok(b, { imageOrigins: ['https://www.gutenberg.org'] });
});

test('rejects an unknown type, keeping the agent’s fallback', () => {
  const r = bad(base('timeline', { items: [] }), /Unknown type “timeline”/);
  assert.equal(r.reason, 'unknown-type');
  assert.equal(r.fallback, 'Plain text version.');
});

test('rejects a newer version than the app reads', () => {
  const r = bad(base('progress', { version: 3, steps: [] }), /version 3.*up to version 1/);
  assert.equal(r.reason, 'newer-version');
});

test('rejects a misspelled field instead of ignoring it', () => {
  bad(base('choice', { options: [{ id: 'a', label: 'A' }], multipel: true }), /unknown field “multipel”/);
});

test('rejects missing required fields', () => {
  bad({ id: 'b', type: 'choice', version: 1, options: [{ id: 'a', label: 'A' }] }, /fallback is required/);
  bad(base('confirm', { statement: 'Do it' }), /confirmLabel is required/);
  bad(base('image', { src: 'https://www.gutenberg.org/x.png' }), /alt is required/, { imageOrigins: ['https://www.gutenberg.org'] });
});

test('rejects an option with no label', () => {
  bad(base('choice', { options: [{ id: 'a', label: 'A' }, { id: 'b' }] }), /options\[1\]\.label is required/);
});

test('rejects duplicate option ids', () => {
  bad(
    base('choice', {
      options: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    }),
    /two items with the id “a”/,
  );
});

test('rejects images from origins that aren’t allowed, and non-https images', () => {
  bad(base('image', { src: 'https://evil.example/x.png', alt: 'x' }), /allowed origin/, { imageOrigins: ['https://www.gutenberg.org'] });
  bad(base('image', { src: 'http://www.gutenberg.org/x.png', alt: 'x' }), /allowed origin/, { imageOrigins: ['http://www.gutenberg.org'] });
  bad(base('image', { src: 'javascript:alert(1)', alt: 'x' }), /allowed origin/, { imageOrigins: ['https://www.gutenberg.org'] });
});

test('rejects table cells for columns that don’t exist', () => {
  bad(base('table', { columns: [{ id: 'a', label: 'A' }], rows: [{ id: 'r', cells: { b: 1 } }] }), /unknown column “b”/);
});

test('a select field needs options, and only a select may have them', () => {
  bad(base('form', { fields: [{ id: 's', label: 'S', kind: 'select' }] }), /needs options/);
  bad(base('form', { fields: [{ id: 't', label: 'T', kind: 'text', options: [{ id: 'a', label: 'A' }] }] }), /only applies to a select/);
});

test('an app review needs an appId; other reviews need content', () => {
  bad(base('review', { format: 'app' }), /needs appId/);
  bad(base('review', { format: 'code' }), /needs content/);
});

test('rejects things that aren’t blocks at all', () => {
  for (const v of [null, 'text', 42, [1, 2]]) bad(v, /must be an object/);
});

test('card actions are capped at three', () => {
  bad(base('card', { actions: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: `A${n}` })) }), /more than 3 items/);
});

test('#94, #106: choice, form, confirm and review take an outcome, in Markdown and bounded; other blocks don’t', () => {
  const asking = [
    base('choice', { options: [{ id: 'a', label: 'A' }] }),
    base('form', { fields: [{ id: 'f', label: 'F', kind: 'text' }] }),
    base('confirm', { statement: 'Delete 23 frames?', confirmLabel: 'Delete' }),
    base('review', { format: 'markdown', content: 'x' }),
  ];
  for (const b of asking) {
    ok({ ...b, outcome: 'Done: **23 frames** deleted' });
    bad({ ...b, outcome: 'x'.repeat(501) }, /outcome is longer than 500 characters/);
    bad({ ...b, outcome: '' }, /outcome can’t be empty/);
  }
  bad(base('code', { code: 'x', outcome: 'Done' }), /unknown field “outcome”/);
});

test('ids must be simple, so they are safe to use anywhere', () => {
  bad({ ...base('code', { code: 'x' }), id: 'has space' }, /isn’t a valid id/);
  bad({ ...base('code', { code: 'x' }), id: '<script>' }, /isn’t a valid id/);
});

test('#328 sandbox pages name the script, line and column of inline JavaScript syntax errors', async () => {
  const { scriptSyntaxErrors } = await import('../server/sandbox.mjs');
  assert.deepEqual(scriptSyntaxErrors('<script>\nconst ok = 1;\nconst broken = (1;\n</script>'), [
    "SyntaxError: Unexpected token ';' (script 1, line 3, column 18)",
  ]);
  assert.deepEqual(scriptSyntaxErrors('<script>const broken = (1;</script\t\n ignored>'), ["SyntaxError: Unexpected token ';' (script 1, line 1, column 18)"]);
  assert.deepEqual(scriptSyntaxErrors('<script type="application/json">{not JavaScript}</script><script>const ok = true;</script>'), []);
});

test('every sandbox page is served with a sandbox policy, so it never runs with Postbox’s origin', async () => {
  const { csp, mermaidPage, sandboxPage } = await import('../server/sandbox.mjs');
  const app = { id: 'a1', title: 'T', versions: [{ v: 1, code: '<p>hi</p>', permissions: [] }], current: 1 };
  for (const page of [
    sandboxPage({ origin: 'http://x', app, version: app.versions[0], theme: 'dark', check: false }),
    mermaidPage({ origin: 'http://x', theme: 'light' }),
  ]) {
    assert.match(page.csp, /^sandbox allow-scripts;/);
    assert.ok(!/allow-same-origin/.test(page.csp));
  }
  assert.match(csp('http://x'), /connect-src 'none'/);
});

test('#180: Postbox’s own media moves to the page’s origin, so a page opened at either spelling loads it', async () => {
  const { onPageOrigin } = await import('../shared/urls.mjs');
  const src = 'http://127.0.0.1:4191/media/middlemarch-title.svg?v=1';
  assert.equal(onPageOrigin(src, 'http://localhost:4191'), 'http://localhost:4191/media/middlemarch-title.svg?v=1');
  assert.equal(onPageOrigin(src, 'http://127.0.0.1:4191'), src);
  // Not Postbox’s: another port, another host, or https from an allowed origin.
  assert.equal(onPageOrigin('http://127.0.0.1:9999/x.png', 'http://localhost:4191'), 'http://127.0.0.1:9999/x.png');
  assert.equal(onPageOrigin('https://www.gutenberg.org/x.png', 'http://localhost:4191'), 'https://www.gutenberg.org/x.png');
});

test('a type named after an Object property is unknown, not a crash', () => {
  for (const type of ['constructor', 'toString', '__proto__']) {
    const r = validateBlock(base(type));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-type');
  }
});
