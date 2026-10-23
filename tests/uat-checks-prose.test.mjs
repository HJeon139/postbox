// #213: prose-instead-of-block (#63) reads what a reply leaves for the person, not its length or its question marks.
// The replies are from the UAT runs of 21–23 October 2026, cut to the lines the rule reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksInProse } from '../tools/uat/block-use.mjs';
import { runChecks } from '../tools/uat/checks.mjs';

const hits = (text) => {
  const f = {
    state: { threads: { t1: { id: 't1', kind: 'thread' } }, items: { t1: [{ id: 'a', kind: 'agent', turnId: 'u1', handle: 'researcher', text }] }, apps: {} },
    threads: ['t1'],
  };
  return runChecks(f, { only: ['prose-instead-of-block'] }).filter((x) => x.issue === 63);
};
const lines = (n, line) => Array.from({ length: n }, (_, i) => `${line} ${i + 1}.`).join('\n');

test('a report of what was done, ending with one next step to offer, asks nothing in prose', () => {
  // workroom at 86d9e5f: flagged as “questions or options asked in prose”.
  const allPass = `@critic I ran the tests myself, since shell is on for me. All 8 pass (\`python3 -m unittest test_converter\`, output \`OK\`). Your edge cases behave as you described:

- \`1e-9 m km\` prints \`1e-09 m = 1e-12 km\`, so the \`:g\` scientific notation switch is real.
- \`nan m ft\` and \`inf m ft\` print \`nan\` and \`inf\` results with exit 0.
- \`1 KM m\` fails with \`unknown unit: KM\` and exit 1.

I haven't changed the code yet. Should I add the \`math.isfinite\` check and a test for it, and decide whether to keep \`:g\` display? Both are small changes.`;
  // scifact at 7fa3a6d, the same way.
  const review = `@critic's review found four things to fix. I've made two of them, and the other two stay open.

**Fixed:**
- **Tokenizer:** the run lowercases the text. The app now says this too (v3).
- **Naming:** the app now says "BeIR test (original dev) claims."

**Open:**
- **BEIR figure:** I couldn't confirm the 0.665 BM25 SciFact number, [arXiv 2104.08663](https://arxiv.org/pdf/2104.08663).

Should I add the two corrections to the explainer and drop the "matches" wording until the BEIR number is checked? I can do that now.`;
  for (const text of [allPass, review]) {
    assert.equal(asksInProse(text), null);
    assert.deepEqual(hits(text), []);
  }
});

test('an exercise and its answer inside <details>, a long explainer, and questions that answer themselves ask nothing', () => {
  // wikisearch at the wave 4 integration: flagged as “a long draft sent as prose”.
  const explainer = `# How retrieval works\n\n${lines(45, 'BM25 scores each abstract')}\n\n### Exercise\n\nBM25 returns **A, B, C, D**. Vector search returns **C, A, E**. Which order does fusion give?\n\n<details><summary>Answer</summary>\n\nWhy? Because $\\tfrac{1}{61}$ beats… Which one wins? A.\n</details>\n\nIf you send me a sample of your wiki’s queries, I can turn step 5 into a small evaluation app.`;
  assert.equal(asksInProse(explainer), null);
  assert.deepEqual(hits(explainer), []);
  // A dataset’s own questions, a table of them, a code block and a URL’s “?” aren’t questions to the person.
  const data = `- Row 3\n- Row 8\nQuestion: Are the Laleli Mosque and Esma Sultan Mansion in the same neighborhood?\n| 20 | Which "Roseanne" star is in Scream 2? | Laurie Metcalf |\n\`\`\`mermaid\nflowchart LR\n  Q["Which 1969 novel?"]\n\`\`\`\nSources: [rows API](https://datasets-server.huggingface.co/rows?dataset=hotpotqa&offset=1)`;
  assert.equal(asksInProse(data), null);
  // Rhetorical questions the reply answers itself, with no “you” in their lines.
  assert.equal(asksInProse('Why lower? I haven’t tested this.\n**Does it matter?** Barely.\nIt’s 10.'), null);
});

test('options to pick from and questions for the person, in prose, are still #63', () => {
  // hotpotqa on 22 October: two alternatives for the person.
  const options = `**What I’m leaving open**\n\n- I haven’t checked the other genus-vs-species pairs.\n- I haven’t run anything with or without context.\n\nStill open from my last message: should I scan the 200 questions for other pairs like Q4, or bring researcher back to fix the filter?`;
  assert.equal(asksInProse(options), 'options');
  // p0 at c7a4066: two decisions asked of the person in one line.
  const two =
    'Two things need your decision before I can finish. Do you want to allow the pending wake so @critic can continue the rounds? And who should be the go/no-go owner? I can leave that as a placeholder.';
  assert.equal(asksInProse(two), 'questions');
  // p0 at c7a4066: three values, as a list, asked with “which”.
  const values = `I need three concrete values from you before this can be released:\n- **Rollback plan:** Which version should it target, and what triggers it?\n- **1.x end-of-life date:** the date the 1.x line stops receiving fixes.\n- **Go/no-go owner:** the person who signs off on items 10–14.`;
  assert.equal(asksInProse(values), 'options');
  assert.deepEqual(
    hits(values).map((h) => h.title),
    ['Questions or options were asked in prose, not a form or choice block'],
  );
  assert.equal(asksInProse('Who reads it? How long should it be? When is it due?'), 'questions');
});

test('a draft is something the reply asks the person to approve, not a report that mentions an approval', () => {
  const design = `## What to measure\n\n${lines(12, 'Closed-book accuracy on the renamed set')}\n\nIf you approve the design, the next step is one small run of 20 questions.`;
  assert.equal(asksInProse(design), 'draft');
  assert.deepEqual(
    hits(design).map((h) => h.title),
    ['A draft to approve was sent as prose, not a review block'],
  );
  // p0 at 7fa3a6d: a report of a file written from an approved revision.
  const wrote = `I wrote \`CHECKLIST.md\` from the approved revision 7.\n\nThe file still has open placeholders, as you accepted:\n${lines(8, '- the install channel, item')}\n\nNone of these can be checked until you point me at the project.`;
  assert.equal(asksInProse(wrote), null);
  // Pointing at the block that holds the draft, or asking to approve that block, isn’t a draft in prose.
  assert.equal(asksInProse(`${lines(10, 'Changed item')}\nOnce you approve the block, I’ll write CHECKLIST.md.`), null);
  assert.equal(asksInProse(`${lines(10, 'Changed item')}\nThe review block above has it. If you approve the design, I’ll start.`), null);
});
