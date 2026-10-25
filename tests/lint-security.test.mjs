import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJs } from '../tools/lint-security.mjs';

const lines = (src, opts) => checkJs(src, 'server/x.mjs', opts).map((f) => f.line);

test('lint-security regex: a pattern built at run time needs escapeRe() or a reason (#344)', () => {
  assert.deepEqual(lines('const r = new RegExp(`^${term}$`);'), [1]);
  assert.deepEqual(lines("const r = new RegExp('^' + term);"), [1]);
  assert.deepEqual(lines('const r = new RegExp(String.raw`a${ARG}`);'), [1]);
  // Constants: one string, a template with nothing spliced in, or a constant regex's own source.
  assert.deepEqual(lines("const r = new RegExp('^a+$', 'g');"), []);
  assert.deepEqual(lines('const r = new RegExp(`^a+$`);'), []);
  assert.deepEqual(lines("const r = new RegExp(EDGE.source, 'g');"), []);
  assert.deepEqual(lines('const r = new RegExp(`^${escapeRe(term)}$`);'), []);
  assert.deepEqual(lines('// lint-allow regex: DIGITS is a constant list.\nconst r = new RegExp(`(${DIGITS.join("|")})`);'), []);
  // A reason is required, and new RegExp in a string or a comment is no regex.
  assert.deepEqual(lines('// lint-allow regex:\nconst r = new RegExp(`${t}`);'), [2]);
  assert.deepEqual(lines("const s = 'new RegExp(x)'; // new RegExp(y)"), []);
});

test('lint-security tags: tags are stripped only by stripTags() (#345)', () => {
  assert.deepEqual(lines("const t = html.replace(/<[^>]+>/g, '');"), [1]);
  assert.deepEqual(lines("const t = html\n  .replace(/<[^>]*>/g, ' ');"), [2]);
  assert.deepEqual(lines('const parts = html.split(/(<[^>]+>)/);'), []);
  assert.deepEqual(lines("const t = stripTags(html).replace(/[*_]/g, '');"), []);
});

test('lint-security token: a token is compared only through sameToken() (#351)', () => {
  assert.deepEqual(lines('if (turn.token !== turnToken) fail();'), [1]);
  assert.deepEqual(lines('return sent === token;'), [1]);
  assert.deepEqual(lines('if (turnToken === null) fail();'), []);
  assert.deepEqual(lines('return sent.length === token.length && timingSafeEqual(sent, token);'), []);
  assert.deepEqual(lines('if (!sameToken(turn?.token, turnToken)) fail();'), []);
});

test('lint-security git: git runs only through runGit() (#351)', () => {
  assert.deepEqual(lines("execFileSync('git', ['status']);"), [1]);
  assert.deepEqual(lines("const c = spawn('git', args, { cwd });"), [1]);
  assert.deepEqual(lines("spawn('claude', args);"), []);
  assert.deepEqual(
    checkJs("exec('git', args, opts, done);\nexecFile('git', args);", 'server/ledger-git.mjs').map((f) => f.line),
    [],
  );
});

test('lint-security page-code: a value goes into page code through js(), not JSON.stringify (#343)', () => {
  const page = (src) => checkJs(src, 'tools/check-x.mjs', { pageCode: true }).map((f) => f.line);
  assert.deepEqual(page('await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);'), [1]);
  assert.deepEqual(page('await page.waitFor(\n  `x === ${J(id)}`,\n);'), [2]);
  assert.deepEqual(page('await clickAt(`document.querySelector(${JSON.stringify(sel)})`, label);'), [1]);
  assert.deepEqual(page('await page.evaluate(`location.hash = ${js(hash)}`);'), []);
  // A failure message may show a value as JSON, and so may a template inside js().
  assert.deepEqual(page('throw new Error(`got ${JSON.stringify(v)}`);'), []);
  assert.deepEqual(page('await page.waitFor(`x === ${js(`#/t/${JSON.stringify(id)}`)}`);'), []);
  // The other rules don't apply to tools/.
  assert.deepEqual(page('const r = new RegExp(`^${rule}`);'), []);
});
