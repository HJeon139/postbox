import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLint, introducedTerms, lintMessage, personSaid, rawHtmlProblems, termProblems } from '../server/checks.mjs';

const app = (code, message) => ({ code, message, scope: { kind: 'app', id: 'pairs', title: 'Pair explorer' } });

test('a lint message drops repeated problems, and groups the rest by what they’re about', () => {
  const m = lintMessage([...termProblems('Step 2, then Step 2 again.', {}), app('marks-too-small', 'Tiny.'), app('marks-too-small', 'Tiny.')]);
  assert.equal(m.problems.length, 2);
  const text = formatLint(m);
  assert.match(text, /^\[Postbox\] Your reply used terms you haven’t defined\. Define each with define_term:\n- Step 2/);
  assert.match(text, /Your app “Pair explorer” \(id pairs\) is shown, with these warnings:\n- Tiny\./);
  assert.match(text, /Fix each app with update_app\./);
});

test('a lint turn that only needs tool calls tells the agent no reply is needed', () => {
  assert.match(formatLint(lintMessage(termProblems('Phase 3', {}))), /No reply is needed/);
  const diagram = { code: 'text-too-small', message: 'Small.', scope: { kind: 'diagram', index: 0, excerpt: 'flowchart LR\nA-->B' } };
  const text = formatLint(lintMessage([diagram]));
  assert.match(text, /Diagram 1 in your reply can’t be read \(it starts “flowchart LR”\):\n- Small\./);
  assert.doesNotMatch(text, /No reply is needed/);
});

test('#55: numbered terms the person wrote, or that title a block or app on screen, need no definition', () => {
  const items = [
    { kind: 'user', text: 'I think step 2 should show matched text as a highlight.' },
    { kind: 'block', valid: true, block: { type: 'card', title: 'Phase 3 plan', body: '## Option 4\nDetails.' } },
    { kind: 'block', valid: true, block: { type: 'progress', steps: [{ id: 'a', label: 'Stage 6', state: 'done' }] } },
    { kind: 'agent', text: 'Rule 9 is mine.' },
  ];
  const apps = [{ title: 'Retrieval test', current: 1, versions: [{ code: '<section><h2 class="x">Milestone <b>5</b></h2></section>' }] }];
  const introduced = introducedTerms(items, apps);
  const flagged = termProblems('Step 2, Phase 3, Option 4, Milestone 5, Stage 6, and then Rule 9 and Step 7.', {}, introduced);
  assert.deepEqual(
    flagged.map((p) => p.scope.term),
    ['Rule 9', 'Step 7'],
  );
});

test('raw HTML in a reply is flagged, except <details> and <summary> without attributes', () => {
  assert.deepEqual(rawHtmlProblems('<details><summary>Answer</summary>\n50%\n</details>'), []);
  assert.deepEqual(rawHtmlProblems('An example:\n\n    <div class="x">indented code</div>\n'), []);
  assert.deepEqual(rawHtmlProblems('A Promise<void>, a `<div>` in code, <https://example.com>, and $a<b>c$.\n\n```html\n<div>x</div>\n```'), []);
  const [p] = rawHtmlProblems('Line one<br>line two, <b>bold</b>, and <details open><summary>Hint</summary>x</details>.');
  assert.equal(p.code, 'raw-html');
  assert.deepEqual(p.scope, { kind: 'reply' });
  assert.match(p.message, /^It has raw HTML \(<br>, <b>, <details …>\)\. Postbox shows HTML as text/);
  assert.match(formatLint(lintMessage([p])), /In your reply:\n- It has raw HTML/);
});

test('#55: any term the person used, in any case, needs no definition; one the agent coined still does', () => {
  const said = personSaid([
    { kind: 'user', text: 'Build an eval (say 20 questions, Distractor   setting) and show supporting facts.' },
    { kind: 'agent', text: 'I’ll use the [gold set](term:gold-set).' },
  ]);
  const reply =
    'Using the [distractor setting](term:distractor-setting), [supporting facts](term:supporting-facts), the [gold set](term:gold-set) and [support](term:support).';
  assert.deepEqual(
    termProblems(reply, {}, new Set(), said).map((p) => p.scope.term),
    ['gold set', 'support'],
    'what the agent said doesn’t count, and “support” isn’t “supporting”',
  );
});
