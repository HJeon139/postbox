// Did the agent choose a picture or words (#983, #206)? A judged run records the first visual an agent showed (an app,
// an image block or a Mermaid diagram in its reply) and how many times the person spoke or clicked before it, read from
// the run’s own Postbox log. `- expects: picture` or `- expects: words` says which answer the scenario’s question
// should get, so a picture where words were right counts as a miss, not a success.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lines } from './history.mjs';

export const EXPECTS = ['picture', 'words'];

/** `- expects: picture` or `- expects: words`; anything else is refused, not ignored. @param {string|undefined} spec */
export function expectsOf(spec) {
  if (spec === undefined) return null;
  const v = String(spec).trim();
  if (EXPECTS.includes(v)) return v;
  throw new Error(`- expects takes “picture” or “words”, not “${v}”.`);
}

/** Postbox’s event log in a data folder, in order: events-1.jsonl, events-2.jsonl… @param {string} data */
export function logEvents(data) {
  if (!existsSync(data)) return [];
  const segments = readdirSync(data)
    .map((f) => f.match(/^events-(\d+)\.jsonl$/))
    .filter((m) => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  // lines() unwraps a commit’s array line and skips a torn last one: the report is read while Postbox still writes.
  return segments.flatMap((m) => lines(readFileSync(join(data, m[0]), 'utf8')));
}

/**
 * The person’s first message and what answered it, from a run’s Postbox data folder: the first visual after it (an
 * app or image block, or a Mermaid fence in a reply), the item that shows it, and how many times the person spoke or
 * clicked before it (0 is the first reply). `reply` is the agents’ words in the reply the visual is in, or the first
 * when there’s none (#995 compares it with a words-only answer): from that input to the person’s next message, since a
 * click on the agent’s own card is part of getting its answer. `nextMessageAt` is when that message came, or null. `replied` says whether any agent wrote anything,
 * so a run whose agent never answered isn’t read as one that chose words. Null when the log doesn’t hold the person’s
 * first message (a run that never sent one, or a log cut by a snapshot).
 * @param {string} data  the run’s Postbox data folder
 * @returns {{ question: string, visual: { kind: 'app'|'image'|'diagram', itemId: string, inputsBefore: number } | null, reply: string, replied: boolean, nextMessageAt: number|null } | null}
 */
export function firstExchange(data) {
  const kinds = new Map();
  const text = new Map();
  const replyOf = new Map(); // agent item id → how many inputs came before it
  let inputs = -1; // the person’s first message makes it 0
  let question = '';
  let visual = null;
  const messages = []; // the person’s messages, not clicks: [their input’s number, when]
  const saw = (kind, itemId) => {
    visual ??= { kind, itemId, inputsBefore: inputs };
  };
  for (const e of logEvents(data)) {
    if (e.type === 'item.add') {
      const it = e.data.item;
      kinds.set(it.id, it.kind);
      if (it.kind === 'user' || it.kind === 'voice') inputs++;
      if (it.kind === 'user') messages.push([inputs, it.at ?? null]);
      if (inputs === 0 && (it.kind === 'user' || it.kind === 'voice')) question = it.text ?? '';
      if (inputs < 0) continue;
      // An app is a catalog block of type app (shared/catalog.mjs), as an image is.
      if (it.kind === 'block' && (it.block?.type === 'app' || it.block?.type === 'image')) saw(it.block.type, it.id);
      if (it.kind !== 'agent') continue;
      text.set(it.id, it.text ?? '');
      replyOf.set(it.id, inputs);
      if (text.get(it.id).includes('```mermaid')) saw('diagram', it.id);
    } else if (e.type === 'item.text' && inputs >= 0 && kinds.get(e.data.id) === 'agent') {
      // A reply streams in chunks: a diagram counts once its fence has arrived.
      const t = (text.get(e.data.id) ?? '') + e.data.text;
      text.set(e.data.id, t);
      if (t.includes('```mermaid')) saw('diagram', e.data.id);
    }
  }
  if (inputs < 0) return null;
  const which = visual?.inputsBefore ?? 0;
  const [until, nextMessageAt] = messages.find(([n]) => n > which) ?? [Number.POSITIVE_INFINITY, null];
  const inReply = (id) => replyOf.get(id) >= which && replyOf.get(id) < until;
  const said = [...text].filter(([id, t]) => inReply(id) && t.trim() !== '').map(([, t]) => t.trim());
  const replied = [...text.values()].some((t) => t.trim() !== '');
  return { question, visual, reply: said.join('\n\n'), replied, nextMessageAt };
}

/**
 * The first visual after the person’s first message (firstExchange), as #983 counts it.
 * Null when the log doesn’t hold the person’s first message. With no visual, `replied` says whether the agent wrote
 * anything after that message.
 * @param {string} data  the run’s Postbox data folder
 * @returns {{ first: 'app'|'image'|'diagram'|null, inputsBefore: number|null, replied?: boolean } | null}
 */
export function pictureChoice(data) {
  const x = firstExchange(data);
  if (!x) return null;
  if (x.visual) return { first: x.visual.kind, inputsBefore: x.visual.inputsBefore };
  return { first: null, inputsBefore: null, replied: x.replied };
}

/** The choice in words: never drew, drew in the first reply, or drew after the person spoke or clicked. */
function saidOf({ first, inputsBefore }) {
  const what = { app: 'an app', image: 'an image', diagram: 'a Mermaid diagram' };
  if (first === null) return 'never drew';
  if (inputsBefore === 0) return `drew ${what[first]} in its first reply`;
  const times = inputsBefore === 1 ? 'once' : `${inputsBefore} times`;
  return `drew ${what[first]} after the person spoke or clicked ${times}`;
}

/** What the choice was, in words, and whether it met the scenario’s `- expects`. @param {string|null} expects @param {ReturnType<typeof pictureChoice>} choice */
export function pictureVerdict(expects, choice) {
  if (!choice) return { said: 'unknown: the log doesn’t hold the person’s first message', met: null };
  if (choice.first === null && !choice.replied) return { said: 'never replied', met: null };
  const said = saidOf(choice);
  if (!expects) return { said, met: null };
  const drewFirst = choice.first !== null && choice.inputsBefore === 0;
  return { said, met: expects === 'picture' ? drewFirst : choice.first === null };
}

/** The report’s line on it, for a judged run or one that says what it expects. @param {any} scenario @param {string} dir */
export function pictureSection(scenario, dir) {
  if (scenario.judge !== 'visual' && !scenario.expects) return [];
  const { said, met } = pictureVerdict(scenario.expects, pictureChoice(join(dir, 'data')));
  let outcome = met ? 'met' : 'not met';
  if (met === null) outcome = 'unknown';
  const answer = scenario.expects === 'picture' ? 'a picture in the first reply' : 'words, with no picture';
  const expected = scenario.expects ? ` The question should get ${answer} (\`- expects: ${scenario.expects}\`): ${outcome}.` : '';
  return ['## Picture or words', '', `The agent ${said}.${expected}`, ''];
}

/** For run.json: the choice, and whether it met the scenario’s `- expects`. @param {any} scenario @param {string} dir */
export function pictureRecord(scenario, dir) {
  if (scenario.judge !== 'visual' && !scenario.expects) return {};
  const choice = pictureChoice(join(dir, 'data'));
  return {
    picture: {
      expects: scenario.expects ?? null,
      ...(choice ?? { first: null, inputsBefore: null, unknown: true }),
      met: pictureVerdict(scenario.expects, choice).met,
    },
  };
}
