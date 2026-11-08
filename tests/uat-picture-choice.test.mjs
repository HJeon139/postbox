// Did the agent choose a picture or words (tools/uat/picture-choice.mjs, #983)? Read from the run’s own Postbox log:
// the first visual after the person’s first message, and how many times the person spoke or clicked before it.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expectsOf, pictureChoice, pictureRecord, pictureSection, pictureVerdict } from '../tools/uat/picture-choice.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const add = (id, kind, extra = {}) => ({ type: 'item.add', data: { threadId: 'th_1', item: { id, kind, ...extra } } });
const chunk = (id, text) => ({ type: 'item.text', data: { threadId: 'th_1', id, text } });

/** A run folder whose Postbox log holds these events, split over segments as Postbox writes them. */
function runWith(...segments) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-picture-'));
  mkdirSync(join(dir, 'data'));
  segments.forEach((events, i) => {
    writeFileSync(join(dir, 'data', `events-${i + 1}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  return dir;
}

const md = (header) => `# A scenario\n\n- persona: Someone.\n${header}\nSummary.\n\n## Phase 1: Ask\n\nAsk.\n`;

test('`- expects` takes picture or words, and a mistyped one is refused, not run without it', () => {
  assert.equal(parseScenario(md('- expects: words')).expects, 'words');
  assert.equal(parseScenario(md('')).expects, null);
  assert.throws(() => expectsOf('pictures'), /- expects takes “picture” or “words”, not “pictures”/);
});

test('an app in the reply to the first message is a picture in the first reply', (t) => {
  const dir = runWith([
    add('it_1', 'user', { text: 'Where should we start?' }),
    add('it_2', 'agent', { text: '' }),
    add('it_3', 'block', { block: { type: 'app' } }),
  ]);
  t.after(() => rmSync(dir, { recursive: true }));
  assert.deepEqual(pictureChoice(join(dir, 'data')), { first: 'app', inputsBefore: 0 });
});

test('a Mermaid diagram counts once its fence has streamed in, and a later segment of the log is read too', (t) => {
  const dir = runWith(
    [add('it_1', 'user', { text: 'How does it work?' }), add('it_2', 'agent', { text: 'Here: ' })],
    [chunk('it_2', '``'), chunk('it_2', '`mermaid\nflowchart LR\n')],
  );
  t.after(() => rmSync(dir, { recursive: true }));
  assert.deepEqual(pictureChoice(join(dir, 'data')), { first: 'diagram', inputsBefore: 0 });
});

test('choices and forms the person answers before a chart count as inputs, so the chart is a later picture', (t) => {
  const dir = runWith([
    add('it_1', 'user', { text: 'Where should we start?' }),
    add('it_2', 'block', { block: { type: 'choice' } }),
    add('it_3', 'voice', { text: 'Chose: both' }),
    add('it_4', 'block', { block: { type: 'table' } }),
    add('it_5', 'user', { text: 'Just show me the numbers.' }),
    add('it_6', 'block', { block: { type: 'app' } }),
  ]);
  t.after(() => rmSync(dir, { recursive: true }));
  const choice = pictureChoice(join(dir, 'data'));
  assert.deepEqual(choice, { first: 'app', inputsBefore: 2 });
  assert.deepEqual(pictureVerdict('picture', choice), { said: 'drew an app after the person spoke or clicked 2 times', met: false });
});

test('words, with no picture, meet a control and miss a picture question', (t) => {
  const dir = runWith([add('it_1', 'user', { text: 'How many are there?' }), add('it_2', 'agent', { text: 'Fourteen, $212 a month.' })]);
  t.after(() => rmSync(dir, { recursive: true }));
  const choice = pictureChoice(join(dir, 'data'));
  assert.deepEqual(choice, { first: null, inputsBefore: null, replied: true });
  assert.equal(pictureVerdict('words', choice).met, true);
  assert.equal(pictureVerdict('picture', choice).met, false);
  assert.deepEqual(pictureSection({ judge: 'visual', expects: 'words' }, dir), [
    '## Picture or words',
    '',
    'The agent never drew. The question should get words, with no picture (`- expects: words`): met.',
    '',
  ]);
});

test('an agent that never replied didn’t choose words: the run is unknown, never a met control', (t) => {
  const dir = runWith([add('it_1', 'user', { text: 'How do I start this project?' }), add('it_2', 'agent', { text: '' })]);
  t.after(() => rmSync(dir, { recursive: true }));
  const choice = pictureChoice(join(dir, 'data'));
  assert.deepEqual(choice, { first: null, inputsBefore: null, replied: false });
  assert.deepEqual(pictureVerdict('words', choice), { said: 'never replied', met: null });
});

test('a log without the person’s first message is unknown, never a miss or a pass', (t) => {
  const dir = runWith([add('it_9', 'block', { block: { type: 'app' } })]);
  t.after(() => rmSync(dir, { recursive: true }));
  assert.equal(pictureChoice(join(dir, 'data')), null);
  assert.equal(pictureVerdict('picture', null).met, null);
  assert.deepEqual(pictureRecord({ judge: 'visual', expects: 'picture' }, dir), {
    picture: { expects: 'picture', first: null, inputsBefore: null, unknown: true, met: null },
  });
});

test('a run that neither judges visuals nor expects an answer says nothing about pictures', () => {
  assert.deepEqual(pictureSection({ judge: null, expects: null }, '/nowhere'), []);
  assert.deepEqual(pictureRecord({ judge: null, expects: null }, '/nowhere'), {});
});
