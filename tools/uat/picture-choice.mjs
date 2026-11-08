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
 * The first visual after the person’s first message, from a run’s Postbox data folder.
 * `inputsBefore` counts what the person said or clicked between their first message and that visual: 0 is the first reply.
 * Null when the log doesn’t hold the person’s first message (a run that never sent one, or a log cut by a snapshot).
 * With no visual, `replied` says whether the agent wrote anything after that message, so a run whose agent never
 * answered isn’t read as one that chose words.
 * @param {string} data  the run’s Postbox data folder
 * @returns {{ first: 'app'|'image'|'diagram'|null, inputsBefore: number|null, replied?: boolean } | null}
 */
export function pictureChoice(data) {
  const kinds = new Map();
  const text = new Map();
  let inputs = -1; // the person’s first message makes it 0
  for (const e of logEvents(data)) {
    if (e.type === 'item.add') {
      const it = e.data.item;
      kinds.set(it.id, it.kind);
      if (it.kind === 'user' || it.kind === 'voice') inputs++;
      if (inputs < 0) continue;
      // An app is a catalog block of type app (shared/catalog.mjs), as an image is.
      if (it.kind === 'block' && (it.block?.type === 'app' || it.block?.type === 'image')) return { first: it.block.type, inputsBefore: inputs };
      if (it.kind === 'agent') text.set(it.id, it.text ?? '');
      if (it.kind === 'agent' && text.get(it.id).includes('```mermaid')) return { first: 'diagram', inputsBefore: inputs };
    } else if (e.type === 'item.text' && inputs >= 0 && kinds.get(e.data.id) === 'agent') {
      // A reply streams in chunks: a diagram counts once its fence has arrived.
      const t = (text.get(e.data.id) ?? '') + e.data.text;
      text.set(e.data.id, t);
      if (t.includes('```mermaid')) return { first: 'diagram', inputsBefore: inputs };
    }
  }
  if (inputs < 0) return null;
  return { first: null, inputsBefore: null, replied: [...text.values()].some((t) => t.trim() !== '') };
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
