// #995’s side-by-side judge (tools/uat/side-by-side.mjs): a judged run’s first picture against a words-only answer from
// the same agent, shown to a judge in random order, and the rate over runs against #206’s bar of 7 in 10.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedFiles } from '../tools/uat/fixtures.mjs';
import { pairShot } from '../tools/uat/pair-shot.mjs';
import { firstExchange } from '../tools/uat/picture-choice.mjs';
import { replyShot } from '../tools/uat/picture-shots.mjs';
import { BAR, pairRate, sideBySide, sideBySideSection, wordsSystem, wordsWorkspace } from '../tools/uat/side-by-side.mjs';
import { hideSteeringAbove } from '../tools/uat/steering.mjs';
import { askOnce } from '../tools/uat/tester.mjs';

const add = (id, kind, at, extra = {}) => ({ type: 'item.add', data: { threadId: 'th_1', item: { id, kind, at, ...extra } } });

/** A run folder: its Postbox log, its seeded agents, and screenshots taken at these times (ms). */
function runWith(events, shots = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-pair-'));
  for (const d of ['data', 'shots', 'workspace']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'data', 'events-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const persona = { handle: 'researcher', description: 'Explains data.', instructions: 'Cite sources.' };
  writeFileSync(join(dir, 'data', 'agents.json'), JSON.stringify([persona]));
  for (const [name, at] of Object.entries(shots)) {
    writeFileSync(join(dir, 'shots', name), 'png');
    utimesSync(join(dir, 'shots', name), at / 1000, at / 1000);
  }
  return dir;
}

// An app in the first reply, a click on the agent’s own card, the app’s fixed version, then the next message.
const drew = [
  add('it_1', 'user', 1_000, { text: 'Which should I cancel?' }),
  add('it_2', 'agent', 2_000, { text: 'Drawing it.' }),
  add('it_3', 'block', 3_000, { block: { id: 'subs', type: 'app' } }),
  add('it_4', 'voice', 4_000, { text: 'Chose: That’s enough' }),
  add('it_5', 'agent', 5_000, { text: 'Cancel the gym.' }),
  add('it_6', 'user', 9_000, { text: 'And for a year?' }),
  add('it_7', 'agent', 9_500, { text: 'About $2,000.' }),
];

test('#995 the first exchange is the reply up to the person’s next message, clicks on the agent’s cards included', (t) => {
  const dir = runWith(drew);
  t.after(() => rmSync(dir, { recursive: true }));
  const x = firstExchange(join(dir, 'data'));
  assert.equal(x?.question, 'Which should I cancel?');
  assert.deepEqual(x?.visual, { kind: 'app', itemId: 'it_3', inputsBefore: 0 });
  assert.equal(x?.reply, 'Drawing it.\n\nCancel the gym.');
  assert.equal(x?.nextMessageAt, 9_000);
});

test('#995 the picture is shot as the reply left it, not while its check was at work', (t) => {
  const dir = runWith(drew, { '01-I3.png': 3_500, '03-I3.png': 8_000, '05-I3.png': 9_800 });
  t.after(() => rmSync(dir, { recursive: true }));
  assert.equal(replyShot(join(dir, 'shots'), 'I3', 9_000)?.n, 3);
  assert.equal(replyShot(join(dir, 'shots'), 'I3', null)?.n, 5, 'with no next message, the last shot');
  assert.equal(replyShot(join(dir, 'shots'), 'I9', null), null);
});

/** An ask that answers each schema: the words answer, then the judge’s pick. */
function fakeAsk(pick) {
  const calls = [];
  const ask = async (args) => {
    calls.push(args);
    if (args.schema.properties.answer) return { value: { answer: 'Cancel the gym and the meal kit.' }, cost: 0.2 };
    return { value: { pick, why: 'It shows which ones cost the most per use.' }, cost: 0.05 };
  };
  return { ask, calls };
}

const context = (dir, ask, random) => ({
  scenario: { persona: 'Someone with many subscriptions.', agents: ['researcher'] },
  dir,
  data: join(dir, 'data'),
  workspace: join(dir, 'workspace'),
  shots: join(dir, 'shots'),
  labels: new Map([['it_3', 'I3']]),
  agent: { model: 'claude-opus-5-5', effort: 'high' },
  judgeModel: 'claude-sonnet-5-5',
  ask,
  random: () => random,
});

test('#995 the words answer is the same agent on the same question, in the run’s folder, told to answer in words', async (t) => {
  const dir = runWith(drew, { '03-I3.png': 8_000 });
  t.after(() => rmSync(dir, { recursive: true }));
  const { ask, calls } = fakeAsk('A');
  await sideBySide(context(dir, ask, 0.1));
  const words = calls[0];
  assert.equal(words.prompt, 'Which should I cancel?');
  assert.equal(words.cwd, join(dir, 'workspace'));
  assert.equal(words.model, 'claude-opus-5-5');
  assert.deepEqual(words.extra, ['--permission-mode', 'auto', '--effort', 'high']);
  assert.match(words.append, /You are @researcher\.[\s\S]*Cite sources\.[\s\S]*in words only/);
  assert.equal(readFileSync(join(dir, 'words-answer.md'), 'utf8'), 'Cancel the gym and the meal kit.\n');
  assert.equal(wordsSystem({ handle: 'x' }).includes('Your role'), false, 'a persona without a role says none');
});

test('#995 the words answer starts from the files the run started with, not what the agent left in the run’s folder', (t) => {
  const dir = runWith(drew);
  t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'workspace', 'chart.html'), '<p>the agent’s app</p>');
  // The workspace as makeWorkspace makes it, but for its git init: tests start no process.
  const make = (scenario, paths) => {
    seedFiles(paths.workspace, scenario.files);
    hideSteeringAbove(paths.workspace);
    return null;
  };
  const words = wordsWorkspace({ files: 'subscriptions' }, dir, make);
  assert.equal(words, join(dir, 'words-workspace'));
  assert.ok(readdirSync(words).includes('subscriptions.csv'));
  assert.ok(!existsSync(join(words, 'chart.html')));
  assert.ok(existsSync(join(words, '.claude', 'settings.json')), 'Postbox’s own AGENTS.md is hidden from it');
});

test('#995 the judge sees both in random order, and its pick is read back as the picture or the words', async (t) => {
  const dir = runWith(drew, { '03-I3.png': 8_000 });
  t.after(() => rmSync(dir, { recursive: true }));
  const first = fakeAsk('A');
  const asA = await sideBySide(context(dir, first.ask, 0.1));
  assert.equal(asA.pictureAs, 'A');
  assert.equal(asA.pick, 'picture');
  assert.match(first.calls[1].prompt, /## Answer A\n\nDrawing it\.\n\nCancel the gym\.\n\nWith it, this picture: shots\/03-I3\.png/);
  assert.match(first.calls[1].prompt, /## Answer B\n\nCancel the gym and the meal kit\./);
  assert.match(first.calls[1].prompt, /not its length, its effort or its looks/);
  const second = fakeAsk('A');
  const asB = await sideBySide(context(dir, second.ask, 0.9));
  assert.equal(asB.pictureAs, 'B');
  assert.equal(asB.pick, 'words', 'A is the words when the picture is B');
  assert.deepEqual(asB.cost, { words: 0.2, judge: 0.05 });
  assert.equal((await sideBySide(context(dir, fakeAsk('tie').ask, 0.9))).pick, 'tie');
});

test('#995 a run with no picture, or none on screen, has no pair, and says why', async (t) => {
  const words = runWith([add('it_1', 'user', 1, { text: 'How many?' }), add('it_2', 'agent', 2, { text: '18.' })]);
  const unseen = runWith(drew);
  t.after(() => {
    for (const d of [words, unseen]) rmSync(d, { recursive: true });
  });
  const { ask, calls } = fakeAsk('A');
  assert.deepEqual(await sideBySide(context(words, ask, 0.5)), { skipped: 'the agent answered in words' });
  assert.deepEqual(await sideBySide(context(unseen, ask, 0.5)), { skipped: 'no screenshot of the agent’s app' });
  assert.equal(calls.length, 0, 'nothing is asked without a pair');
  assert.deepEqual(sideBySideSection({ skipped: 'the agent answered in words' }), ['## Side by side', '', 'No pair: the agent answered in words.', '']);
  assert.deepEqual(sideBySideSection(undefined), []);
});

test('#995 the rate over runs counts a tie as no win, and reads against #206’s bar', () => {
  const runs = [...Array(7).fill({ pick: 'picture' }), { pick: 'words' }, { pick: 'tie' }, { pick: 'words' }, { skipped: 'the agent answered in words' }];
  assert.deepEqual(pairRate(runs), { pairs: 10, picture: 7, words: 2, tie: 1, skipped: 1, rate: 0.7, meetsBar: true });
  assert.equal(pairRate([{ pick: 'picture' }, { pick: 'tie' }]).meetsBar, false);
  assert.equal(pairRate([]).rate, null);
  assert.deepEqual(BAR, { wins: 7, of: 10 });
});

test('#995 a call that plays the agent names its own tools, system prompt and arguments', async () => {
  /** @type {string[]} */
  let args = [];
  const run = (_bin, a) => {
    args = a;
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end: () => {} } });
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ structured_output: { answer: 'x' }, total_cost_usd: 0 }));
      child.emit('close', 0);
    });
    return child;
  };
  await askOnce({ cwd: '.', model: 'm', prompt: 'p', schema: {}, tools: 'Read,Bash', append: 'You are @a.', extra: ['--effort', 'low'], run });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Bash');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'You are @a.');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
});

// The app’s v1 failed its check at 3_500 and was shown fixing; v2, fixed, came at 6_000 and passed.
const fixed = [
  ...drew.slice(0, 3),
  { type: 'app', data: { id: 'subs', itemId: 'it_3', versions: [{ v: 1, at: 3_000 }], check: { status: 'fixing' } } },
  {
    type: 'app',
    data: {
      id: 'subs',
      itemId: 'it_3',
      versions: [
        { v: 1, at: 3_000 },
        { v: 2, at: 6_000 },
      ],
      check: { status: 'passed' },
    },
  },
  ...drew.slice(3),
];

test('#995 a shot of the app at work on its check is retaken at the end of the run, or the run has no pair', async (t) => {
  const dir = runWith(fixed, { '01-I3.png': 3_500 });
  t.after(() => rmSync(dir, { recursive: true }));
  const visual = { kind: 'app', itemId: 'it_3' };
  const base = { data: join(dir, 'data'), shots: join(dir, 'shots'), label: 'I3', visual, nextMessageAt: 9_000 };
  assert.deepEqual(await pairShot(base), { skipped: 'no screenshot of the app’s finished version (v2)' });
  const shot = [];
  const shoot = async (label, file) => {
    shot.push(label);
    return file;
  };
  const r = await pairShot({ ...base, shoot });
  assert.deepEqual(shot, ['I3']);
  assert.equal('shot' in r && r.shot.file, join(dir, 'shots', 'judge-I3.png'));
  assert.equal('retaken' in r && r.retaken, true);
  // A shot taken after the last version is the picture as the reply left it.
  const later = runWith(fixed, { '03-I3.png': 7_000 });
  t.after(() => rmSync(later, { recursive: true }));
  const kept = await pairShot({ ...base, shots: join(later, 'shots'), data: join(later, 'data'), shoot });
  assert.equal('shot' in kept && kept.shot.file, join(later, 'shots', '03-I3.png'));
  assert.equal(shot.length, 1, 'nothing retaken');
});
