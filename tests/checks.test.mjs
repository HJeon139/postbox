import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockProblems, formatLint, introducedTerms, lintMessage, personSaid, rawHtmlProblems, termProblems } from '../server/checks.mjs';

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

// #63: replies from the 12-turn research session and the original thread, which went out as prose.
const codes = (text, shown, asked) => blockProblems(text, shown, asked).map((p) => p.code);
const UNBLOCK =
  'I can’t read the shared folder yet.\n\nTo unblock, pick one:\n1. Share the folder with my account\n2. Paste the three documents here\n3. Point me at an export';
const QUESTIONS = `${'Here is the first draft.\n\n'.repeat(1)}A few questions before I revise:\n1. Who is the reader?\n2. How long should it be?\n3. Should it cite the sources?\n4. Is the format fixed?`;
const DRAFT = `Here’s the draft of the summary:\n\n${Array.from({ length: 44 }, (_, i) => `Paragraph ${i + 1} of the summary, with its point.`).join('\n')}\n\nLet me know what you’d change.`;
const TABLE = `I scanned the public datasets:\n\n| Dataset | Size | License |\n| --- | --- | --- |\n${Array.from({ length: 15 }, (_, i) => `| D${i} | ${i}k | CC-BY |`).join('\n')}`;

test('#63 a reply that ends with options, questions, a long draft or a long table should have been a block', () => {
  assert.deepEqual(codes(UNBLOCK), ['options-in-prose']);
  assert.deepEqual(codes(QUESTIONS), ['questions-in-prose']);
  assert.deepEqual(codes(DRAFT), ['draft-in-prose']);
  assert.deepEqual(codes(TABLE), ['table-in-markdown']);
  assert.match(blockProblems(TABLE)[0].message, /a Markdown table of 15 rows/);
  // Next steps in a numbered list, ending with a question, are a choice of what to do next.
  assert.deepEqual(codes('Done. Next we could:\n1. Add ranking\n2. Add filters\n\nWhich should I start with?'), ['options-in-prose']);
});

test('#63 a reply that showed the block, explains in prose, or was asked for in Markdown isn’t flagged', () => {
  assert.deepEqual(codes(UNBLOCK, ['choice']), []);
  assert.deepEqual(codes(QUESTIONS, ['form']), []);
  assert.deepEqual(codes(DRAFT, ['review']), []);
  assert.deepEqual(codes(TABLE, ['table']), []);
  assert.deepEqual(codes(TABLE, [], 'Give me that as a Markdown table'), []);
  // An explanation with a summary list and one closing question; a short table; questions in a heading or code.
  assert.deepEqual(codes('RAG fits here because the corpus changes daily.\n\n- Fresh data\n- No retraining\n\nWant me to sketch the pipeline?'), []);
  assert.deepEqual(codes('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'), []);
  assert.deepEqual(codes('### Why?\n### How?\n### When?\n\n```\na?\nb?\nc?\n```\nThat’s all.'), []);
  // A long explanation that doesn’t hand over a draft.
  assert.deepEqual(codes(Array.from({ length: 50 }, (_, i) => `Step ${i} of the derivation.`).join('\n')), []);
});

test('#63 the lint turn asks for the block, and needs no reply', () => {
  const text = formatLint(lintMessage(blockProblems(UNBLOCK)));
  assert.match(text, /Your reply should have been a block:\n- It ends with options in a list\. Offer them as a choice block/);
  assert.match(text, /Show that block now with show_block, built from what you wrote\./);
  assert.match(text, /No reply is needed/);
  assert.doesNotMatch(text, /reply with a corrected version/);
});

test('#63 a statement about picking isn’t asking the person to pick', () => {
  const demo =
    'Three have more than one edition, so we should pick one each:\n\n- *Middlemarch*: keep the 1874 text.\n- *Emma* and *Persuasion*: keep the editions with chapter headings.\n\nI suggest we keep chapter offsets.';
  assert.deepEqual(codes(demo), []);
  assert.deepEqual(codes('Two ways:\n- Keyword search\n- Embeddings\n\nWhich one should I build first'), ['options-in-prose']);
});
