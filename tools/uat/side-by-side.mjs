// #206’s side-by-side preference (#995): would the person rather have had the agent’s picture, or an answer in words?
// For a judged run’s first picture, the runner asks the same agent the person’s first message once more, with no
// Postbox and none of its skills, told to answer in words. A judge sees both answers, in random order, and picks one
// or a tie, as the person. #206’s bar is the picture preferred in 7 of 10 pairs; a model judge’s rate isn’t that bar
// until its agreement with the maintainer’s blind picks is known (tools/uat-pairs.mjs).
//
// The words answer is one `claude -p` turn, not a second run: the same model and effort, the persona’s role and
// instructions, the run’s own project folder and the tools to read and count in it, on the same question. A second
// run would cost a whole run (a tester, a browser, its other steps) for one reply, and Postbox’s guide only adds how
// to show blocks and apps, which a words answer doesn’t use.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { firstExchange } from './picture-choice.mjs';
import { replyShot } from './picture-shots.mjs';

/** #206’s bar: the picture preferred in this many of these pairs. */
export const BAR = { wins: 7, of: 10 };

const WORDS_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string', description: 'Your whole reply to the person, in Markdown.' } },
  required: ['answer'],
};

export const PAIR_SCHEMA = {
  type: 'object',
  properties: {
    pick: { enum: ['A', 'B', 'tie'] },
    why: { type: 'string', description: 'One or two sentences, as the person: what made you pick it.' },
  },
  required: ['pick', 'why'],
};

/** The agent the run’s first message went to, as the run seeded it (tools/uat/seed.mjs). @param {string} data @param {string} handle */
export function personaOf(data, handle) {
  try {
    const agents = JSON.parse(readFileSync(join(data, 'agents.json'), 'utf8'));
    return agents.find((p) => p.handle === handle) ?? { handle };
  } catch {
    return { handle };
  }
}

/** The system prompt the words answer appends: who the agent is, and to answer in words. @param {{ handle: string, description?: string, instructions?: string }} p */
export function wordsSystem(p) {
  return [
    `You are @${p.handle}.`,
    p.description ? `Your role: ${p.description}` : '',
    p.instructions ? `The person’s instructions for you:\n${p.instructions}` : '',
    'Answer the person in words only: Markdown text, with no app, picture, chart or diagram. Their files are in this folder; read them as you need.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * What the judge is asked. `first` is the answer shown as A.
 * @param {{ persona: string, question: string, answers: string[] }} o  answers: A’s and B’s text, in that order
 */
export function pairPrompt({ persona, question, answers }) {
  return `You are this person: ${persona}

You asked: “${question}”

Two answers came back. Read both in full before you choose, and open any screenshot an answer names with Read: it’s what you saw on screen.

## Answer A

${answers[0]}

## Answer B

${answers[1]}

Which would you rather have got, as this person, for what you asked? Pick A or B, or tie when neither helps you more. Judge what each lets you understand or decide, not its length, its effort or its looks: an answer isn’t better for being longer, or for being a picture.`;
}

/** The judge’s A, B or tie, read back as the picture, the words or a tie. @param {string} said @param {boolean} pictureFirst */
function pickOf(said, pictureFirst) {
  if (said === 'tie') return 'tie';
  return (said === 'A') === pictureFirst ? 'picture' : 'words';
}

/** The picture answer as the judge reads it: the agent’s words, and the screenshot of its picture. @param {string} reply @param {string} shot */
const pictureAnswer = (reply, shot) => `${reply ? `${reply}\n\n` : ''}With it, this picture: ${shot} (a screenshot; open it with Read).`;

/**
 * Asks for the words answer and the judge’s pick. Returns the record for run.json, or why the run had no pair.
 * @param {{ scenario: any, dir: string, data: string, workspace: string, shots: string, labels: Map<string, string>,
 *   agent: { model: string|null, effort: string|null }, judgeModel: string, ask: (args: any) => Promise<{ value: any, cost: number }>, random?: () => number }} o
 */
export async function sideBySide({ scenario, dir, data, workspace, shots, labels, agent, judgeModel, ask, random = Math.random }) {
  const x = firstExchange(data);
  if (!x) return { skipped: 'the log doesn’t hold the person’s first message' };
  if (!x.visual) return { skipped: x.replied ? 'the agent answered in words' : 'the agent never replied' };
  const label = labels.get(x.visual.itemId) ?? null;
  const shot = label ? replyShot(shots, label, x.nextMessageAt) : null;
  if (!shot) return { skipped: `no screenshot of the agent’s ${x.visual.kind}` };
  const cost = { words: 0, judge: 0 };
  const words = await ask({
    cwd: workspace,
    model: agent.model ?? 'opus',
    prompt: x.question,
    schema: WORDS_SCHEMA,
    tools: 'Read,Grep,Glob,Bash',
    append: wordsSystem(personaOf(data, scenario.agents[0])),
    extra: ['--permission-mode', 'auto', ...(agent.effort ? ['--effort', agent.effort] : [])],
    budgetUsd: 1.5,
  });
  cost.words = words.cost;
  writeFileSync(join(dir, 'words-answer.md'), `${words.value.answer}\n`);
  const pictureFirst = random() < 0.5;
  const picture = pictureAnswer(x.reply, relative(dir, shot.file));
  const answers = pictureFirst ? [picture, words.value.answer] : [words.value.answer, picture];
  const r = await ask({
    cwd: dir,
    model: judgeModel,
    prompt: pairPrompt({ persona: scenario.persona, question: x.question, answers }),
    schema: PAIR_SCHEMA,
    budgetUsd: 1,
  });
  cost.judge = r.cost;
  const pick = pickOf(r.value.pick, pictureFirst);
  return {
    question: x.question,
    picture: { kind: x.visual.kind, item: label, shot: relative(dir, shot.file), inputsBefore: x.visual.inputsBefore },
    words: 'words-answer.md',
    pictureAs: pictureFirst ? 'A' : 'B',
    pick,
    why: r.value.why,
    cost,
  };
}

/** The report’s section on it, for a run that has one. @param {any} record  sideBySide’s, or undefined */
export function sideBySideSection(record) {
  if (!record) return [];
  const head = ['## Side by side', ''];
  if (record.skipped) return [...head, `No pair: ${record.skipped}.`, ''];
  const picked = { picture: 'the picture', words: 'the words', tie: 'neither' }[record.pick];
  return [
    ...head,
    `The person’s first message, answered twice: the agent’s ${record.picture.kind} (\`${record.picture.shot}\`) with its words, and the same agent with no Postbox and its skills off, told to answer in words (\`${record.words}\`). A judge saw both in random order, the picture as ${record.pictureAs}, and as the person preferred **${picked}**: ${record.why}`,
    '',
    'One pair isn’t a rate: tally runs with `node tools/uat-pairs.mjs rate`, against #206’s bar of 7 in 10, once the judge agrees with the maintainer’s blind picks.',
    '',
  ];
}

/**
 * The rate over runs’ records: pairs, and how many the picture, the words or neither won. A tie isn’t a win.
 * @param {any[]} records  run.json’s sideBySide, one per run
 */
export function pairRate(records) {
  const pairs = records.filter((r) => r && !r.skipped && r.pick);
  const count = (pick) => pairs.filter((r) => r.pick === pick).length;
  const picture = count('picture');
  return {
    pairs: pairs.length,
    picture,
    words: count('words'),
    tie: count('tie'),
    skipped: records.filter((r) => r?.skipped).length,
    rate: pairs.length ? picture / pairs.length : null,
    meetsBar: pairs.length ? picture / pairs.length >= BAR.wins / BAR.of : null,
  };
}
