// #585: the fake Responses endpoint the Codex conformance probe runs against. It must take only the placeholder as
// a credential, and the step check must fail a turn whose request lacks its marker. The request fixture is the body
// codex-cli 0.167.0 sent the fake for a turn after thread/start, recorded by the probe’s own --record
// (tests/fixtures/codex-conformance/README.md, “guide-request.json”). Its guide is agentGuide’s, with the marker the
// probe gave it, read back from the fixture.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authResult, stepResult } from '../tools/conformance/codex-turns.mjs';
import { answer, authorizationOk, EXPECTED_AUTHORIZATION, requestMarkers } from '../tools/conformance/fake-responses.mjs';
import { PLACEHOLDER } from '../tools/conformance/sandbox-env.mjs';

const REQUEST = JSON.parse(readFileSync(new URL('fixtures/codex-conformance/guide-request.json', import.meta.url), 'utf8'));
const MARKER = JSON.stringify(REQUEST).match(/postbox-conformance-start-[0-9a-f]{12}/)?.[0] ?? '';
/** The developer text that holds the marker: the guide, whole, as the probe gave it. */
const GUIDE = REQUEST.input.flatMap((item) => item.content ?? []).find((part) => part.text.includes(MARKER))?.text ?? '';
const STEP = { marker: MARKER, guide: GUIDE };
const post = (headers) => ({ url: '/v1/responses', method: 'POST', headers });

test('the recorded request holds a marker and its guide, so the tests below read something', () => {
  assert.ok(MARKER, 'a marker');
  assert.ok(GUIDE.length > 1000, 'the whole guide');
});

test('the fake takes the placeholder as the only Authorization', () => {
  assert.equal(EXPECTED_AUTHORIZATION, `Bearer ${PLACEHOLDER}`);
  assert.equal(authorizationOk({ authorization: `Bearer ${PLACEHOLDER}` }), true);
});

test('any other Authorization, or none, fails the fake’s check', () => {
  for (const authorization of [undefined, '', `Bearer ${PLACEHOLDER}x`, `bearer ${PLACEHOLDER}`, 'Bearer sk-real', PLACEHOLDER])
    assert.equal(authorizationOk({ authorization }), false, String(authorization));
});

test('the fake records each request’s path, body and Authorization check, never the header itself', () => {
  const seen = [];
  const out = answer(post({ authorization: 'Bearer sk-real' }), JSON.stringify(REQUEST), seen);
  assert.equal(out.status, 200);
  assert.equal(out.type, 'text/event-stream');
  assert.match(out.text, /response\.completed/);
  assert.deepEqual(Object.keys(seen[0]), ['path', 'authOk', 'body']);
  assert.equal(seen[0].authOk, false);
  assert.doesNotMatch(JSON.stringify(seen), /sk-real/);
});

test('the fake answers only a POST to …/responses', () => {
  const seen = [];
  assert.equal(answer({ url: '/v1/models', method: 'GET', headers: {} }, '', seen).status, 404);
  assert.equal(seen.length, 1, 'still recorded');
  assert.equal(seen[0].body, null);
});

test('the recorded request holds the guide’s marker once, in a developer message', () => {
  assert.deepEqual(requestMarkers(REQUEST, MARKER, GUIDE), { developer: 1, anywhere: 1, whole: 1 });
  assert.deepEqual(requestMarkers(REQUEST, 'MARK-other'), { developer: 0, anywhere: 0, whole: 0 });
});

test('the marker in a user message isn’t the developer’s', () => {
  const input = REQUEST.input.map((item) => (JSON.stringify(item).includes(MARKER) ? { ...item, role: 'user' } : item));
  assert.deepEqual(requestMarkers({ ...REQUEST, input }, MARKER, GUIDE), { developer: 0, anywhere: 1, whole: 0 });
});

test('a guide whose marker arrived but whose rest was cut off isn’t whole', () => {
  assert.equal(requestMarkers(REQUEST, MARKER, `${GUIDE}\n\nThe catalog’s rules follow.`).whole, 0);
});

const request = { path: '/v1/responses', authOk: true, body: REQUEST };
/** The recorded request with its developer guide’s text changed. @param {(text: string) => string} edit */
const withGuide = (edit) => ({
  ...request,
  body: {
    ...REQUEST,
    input: REQUEST.input.map((item) => ({
      ...item,
      content: (item.content ?? []).map((part) => (part.text === GUIDE ? { ...part, text: edit(GUIDE) } : part)),
    })),
  },
});

test('a step passes only a completed turn whose every request holds its whole guide once, as the developer’s', () => {
  const completed = (requests) => ({ status: 'completed', requests });
  assert.equal(stepResult('s', completed([request]), STEP).ok, true);
  assert.equal(stepResult('s', completed([request]), { marker: 'MARK-other', guide: 'guide MARK-other' }).ok, false, 'a request without it');
  assert.equal(stepResult('s', completed([]), STEP).ok, false, 'no request at all');
  assert.equal(stepResult('s', { status: 'failed', requests: [request] }, STEP).ok, false, 'a turn that didn’t complete');
  assert.equal(stepResult('s', completed([request, withGuide(() => 'guide')]), STEP).ok, false, 'one of two requests without it');
  assert.equal(stepResult('s', completed([withGuide((g) => `${g} ${g}`)]), STEP).ok, false, 'the guide sent twice');
  assert.equal(stepResult('s', completed([request]), { marker: MARKER, guide: `${GUIDE} and more` }).ok, false, 'the guide cut short');
  const alsoAsUser = {
    ...request,
    body: { ...REQUEST, input: [...REQUEST.input, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Note: ${MARKER}` }] }] },
  };
  assert.equal(stepResult('s', completed([alsoAsUser]), STEP).ok, false, 'the guide’s marker in another message too');
});

test('a request that isn’t to …/responses doesn’t count for or against a step', () => {
  const models = { path: '/v1/models', authOk: true, body: null };
  const r = stepResult('s', { status: 'completed', requests: [models, request] }, STEP);
  assert.equal(r.ok, true);
  assert.match(r.detail, /1 request\(s\), this step’s whole guide once in 1/);
});

test('a step that only carries the start’s guide in its history fails, and says so', () => {
  const r = stepResult('resume', { status: 'completed', requests: [request] }, { marker: 'MARK-resume', guide: 'guide MARK-resume' }, MARKER);
  assert.equal(r.ok, false);
  assert.match(r.detail, /this step’s whole guide once in 0; the start’s guide still in 1 of them/);
});

test('the credential check passes only when the fake was sent requests, each with the placeholder alone', () => {
  assert.equal(authResult([{ authOk: true }, { authOk: true }]).ok, true);
  assert.equal(authResult([{ authOk: true }, { authOk: false }]).ok, false, 'one request with another Authorization');
  assert.equal(authResult([]).ok, false, 'no request: nothing was checked');
});
