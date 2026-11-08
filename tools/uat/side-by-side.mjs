// The side-by-side judge (#995): two pictures for the same question, from two conditions, such as a scenario with
// Postbox’s skill against its `-base` twin, or before and after a change to the guide. Each side is the first picture’s
// screenshot and the one sentence it was meant to say, nothing else: the agents’ replies around their pictures are
// mostly setup and process, which a judge read instead of the picture when it saw them. A judge, and the maintainer
// on the calibration page (tools/uat/calibration.mjs), pick the picture that leaves them understanding more, as the
// person who asked. Whether to draw at all is #983’s measure, not this one (tools/uat/picture-choice.mjs).

import { relative } from 'node:path';
import { LIMITS } from '../../shared/limits.mjs';
import { appAt, versionAt } from './intent-match.mjs';
import { pairShot } from './pair-shot.mjs';
import { firstExchange } from './picture-choice.mjs';

export const PAIR_SCHEMA = {
  type: 'object',
  properties: {
    pick: { enum: ['A', 'B', 'tie'] },
    why: { type: 'string', description: 'One or two sentences, as the person: what made you pick it.' },
  },
  required: ['pick', 'why'],
};

/** The first sentence of a text, cut to the intent’s word limit with an ellipsis. @param {string} text */
export function firstSentence(text) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = (/^.*?[.!?](?=\s|$)/.exec(t)?.[0] ?? t).split(' ').filter(Boolean);
  const max = LIMITS.appIntentWords;
  return words.length > max ? `${words.slice(0, max).join(' ')}…` : words.join(' ');
}

/**
 * What the picture was meant to say: the agent’s intent for the version shown (#995), or, for a version from before
 * apps had one, the first sentence of the plain-text version the agent wrote with it, cut to 16 words and marked as
 * such, never as the agent’s intent.
 * @param {ReturnType<typeof appAt>} app @param {number} at  when the screenshot was taken
 * @returns {{ intent: string, intentFrom: 'agent'|'fallback'|null, v: number|null }}
 */
export function meantOf(app, at) {
  const version = app ? versionAt(app.versions, at) : null;
  if (version?.intent) return { intent: version.intent, intentFrom: 'agent', v: version.v };
  const derived = firstSentence(app?.fallback ?? '');
  return { intent: derived, intentFrom: derived ? 'fallback' : null, v: version?.v ?? null };
}

/**
 * A run’s first picture, for run.json: the question, the screenshot as the reply left it, and what it was meant to
 * say. Or why the run has none.
 * @param {{ dir: string, data: string, shots: string, labels: Map<string, string>, shoot?: (label: string, file: string) => Promise<string|null> }} o
 *   labels: item id → the runner’s label; shoot: the runner’s shot of an item now, in a live run (tools/uat/pair-shot.mjs)
 */
export async function firstPicture({ dir, data, shots, labels, shoot }) {
  const x = firstExchange(data);
  if (!x) return { skipped: 'the log doesn’t hold the person’s first message' };
  if (!x.visual) return { skipped: x.replied ? 'the agent answered in words' : 'the agent never replied' };
  const label = labels.get(x.visual.itemId) ?? null;
  if (!label) return { skipped: `no screenshot of the agent’s ${x.visual.kind}` };
  const taken = await pairShot({ data, shots, label, visual: x.visual, nextMessageAt: x.nextMessageAt, shoot });
  if ('skipped' in taken) return taken;
  const app = x.visual.kind === 'app' ? appAt(data, x.visual.itemId) : null;
  return {
    question: x.question,
    kind: x.visual.kind,
    item: label,
    shot: relative(dir, taken.shot.file),
    inputsBefore: x.visual.inputsBefore,
    ...(taken.retaken ? { retaken: true } : {}),
    ...meantOf(app, taken.shot.at),
  };
}

/** How a side’s sentence is introduced, so a derived one is never read as the agent’s. @param {{ intentFrom: string|null }} side */
export function meantLabel(side) {
  if (side.intentFrom === 'agent') return 'What the agent meant it to say';
  if (side.intentFrom === 'fallback') return 'The agent’s text version of it (it gave no intent)';
  return 'It came with no sentence of what it meant to say';
}

/**
 * What the judge is asked: the person, their question, and the two pictures, each with what it was meant to say.
 * @param {{ persona: string, question: string, sides: { file: string, intent: string, intentFrom: string|null }[] }} o  A’s and B’s
 */
export function pairPrompt({ persona, question, sides }) {
  const side = (name, s) => `## Picture ${name}\n\nThe screenshot: ${s.file} (open it with Read).\n${meantLabel(s)}${s.intent ? `: “${s.intent}”` : '.'}`;
  return `You are this person: ${persona}

You asked: “${question}”

Two agents each answered with a picture. Open both screenshots before you choose.

${side('A', sides[0])}

${side('B', sides[1])}

Which picture leaves you understanding more of what you asked, as this person? Judge what the drawing itself shows you, and whether it says what it meant to say. Pick A or B, or tie when neither helps you more. Don’t prefer one for being busier, longer or more polished.`;
}

/**
 * Asks the judge about one pair, in the folder that holds both screenshots. `first` is the side shown as A.
 * @param {{ persona: string, question: string, sides: any[], cwd: string, model: string, ask: (args: any) => Promise<{ value: any, cost: number }> }} o
 * @returns {Promise<{ pick: 'A'|'B'|'tie', why: string, cost: number }>}
 */
export async function judgePair({ persona, question, sides, cwd, model, ask }) {
  const r = await ask({ cwd, model, prompt: pairPrompt({ persona, question, sides }), schema: PAIR_SCHEMA, budgetUsd: 0.5 });
  return { pick: r.value.pick, why: r.value.why, cost: r.cost };
}

/** The report’s line on the run’s first picture, for a run that has one. @param {any} record  firstPicture’s, or undefined */
export function firstPictureSection(record) {
  if (!record) return [];
  const head = ['## First picture', ''];
  if (record.skipped) return [...head, `None to compare: ${record.skipped}.`, ''];
  const meant = record.intent ? `${meantLabel(record)}: “${record.intent}”` : `${meantLabel(record)}.`;
  return [
    ...head,
    `The ${record.kind} as the first reply left it (\`${record.shot}\`${record.retaken ? ', shot at the end of the run' : ''}). ${meant}`,
    '',
    'The side-by-side judge compares it with another run’s, such as its `-base` twin: `node tools/uat-pairs.mjs build`.',
    '',
  ];
}
