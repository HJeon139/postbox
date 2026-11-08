// The customer judges the visual (tools/uat/visual-judge.mjs, #206): a scenario turns it on with `- judge: visual`,
// the tester is told how to judge and may answer with a structured verdict, and the report lists the verdicts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { SCHEMA, systemPrompt } from '../tools/uat/tester.mjs';
import { JUDGING, judgeOf, VERDICTS, visualSection } from '../tools/uat/visual-judge.mjs';

const md = (header) =>
  `# A scenario\n\n- persona: A person who wants one idea explained well enough to tell a friend.\n${header}\nSummary.\n\n## Phase 1: Ask\n\nAsk.\n\n## Phase 2: Follow up\n\nFollow up.\n`;

test('`- judge: visual` turns the customer’s judging on, and a scenario without it leaves it off', () => {
  assert.equal(parseScenario(md('- judge: visual')).judge, 'visual');
  assert.equal(parseScenario(md('')).judge, null);
});

test('a mistyped judge setting is refused, not run without judging', () => {
  assert.equal(judgeOf(undefined), null);
  assert.throws(() => judgeOf('visuals'), /- judge takes “visual”, not “visuals”/);
});

test('the tester is told how to judge only when the scenario asks for it', () => {
  const judging = systemPrompt({ scenario: parseScenario(md('- judge: visual')), issues: [] });
  const plain = systemPrompt({ scenario: parseScenario(md('')), issues: [] });
  assert.ok(judging.includes('Judging the visual') && judging.includes(JUDGING));
  assert.ok(!plain.includes('Judging the visual') && !plain.includes(JUDGING));
});

test('the tester may answer with a visual verdict, which every step doesn’t need', () => {
  assert.deepEqual(SCHEMA.properties.visual.properties.verdict.enum, VERDICTS);
  assert.ok(!SCHEMA.required.includes('visual'));
});

test('the report lists each visual verdict, and adds nothing when no step judged one', () => {
  const visual = { item: 'I4', takeaway: 'Gaps | grow', drawn: false, relationship: true, one_idea: true, readable: true, verdict: 'partly' };
  const lines = visualSection([{ step: 2, visual }, { step: 3 }]);
  assert.equal(lines[0], '## Visual verdicts');
  assert.ok(lines.includes('| 2 | I4 | partly | no | yes | yes | yes | Gaps \\| grow | not an app | – |'));
  assert.deepEqual(visualSection([{ step: 1 }]), []);
});

// The maintainer marked a plain chart with a rate control “landed” (#206): the judge mustn’t count being a chart against it.
test('the judge counts a chart whose marks carry the values as drawn, and labeled boxes as not', () => {
  const drawn = JUDGING.split('\n').find((line) => line.startsWith('- drawn:'));
  assert.match(drawn, /A chart whose marks carry the values is yes/);
  assert.match(drawn, /labeled boxes and arrows is no/);
});
