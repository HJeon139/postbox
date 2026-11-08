// The agent’s intent against the judge’s takeaway (#995). show_app and update_app carry the agent’s one sentence of
// what the picture should leave the reader with, kept with the version. The tester writes what the picture alone says
// (its takeaway, tools/uat/visual-judge.mjs) without seeing the intent. After the run, a judge is given both sentences
// and says whether they match: yes, partly or no.

import { LIMITS } from '../../shared/limits.mjs';
import { wordCount } from '../../shared/text.mjs';
import { inOwnFolder } from './judge-folder.mjs';
import { logEvents } from './picture-choice.mjs';
import { shotAtStep } from './picture-shots.mjs';

export const MATCHES = ['yes', 'partly', 'no'];

export const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    match: { enum: MATCHES },
    why: { type: 'string', description: 'One sentence: what the takeaway has or lacks of the intent.' },
  },
  required: ['match', 'why'],
};

/**
 * The app an item shows, and its versions, from the run’s Postbox log, or null for an item that isn’t an app.
 * @param {string} data  the run’s Postbox data folder @param {string} itemId
 * @returns {{ id: string, versions: { v: number, at: number, intent?: string }[], check: string|null, fallback: string } | null}
 *   check: its last check’s status; fallback: the plain-text version the agent wrote with it (shared/catalog.mjs)
 */
export function appAt(data, itemId) {
  let id = null;
  let fallback = '';
  const versions = new Map();
  const checks = new Map();
  for (const e of logEvents(data)) {
    const it = e.type === 'item.add' ? e.data.item : null;
    if (it?.id === itemId && it.kind === 'block' && it.block?.type === 'app') {
      id = it.block.id;
      fallback = it.block.fallback ?? '';
    }
    if (e.type !== 'app') continue;
    // An app keeps its id when a new version moves it to a new item.
    if (e.data.itemId === itemId) id = e.data.id;
    versions.set(e.data.id, e.data.versions ?? []);
    checks.set(e.data.id, e.data.check?.status ?? null);
  }
  return id ? { id, versions: versions.get(id) ?? [], check: checks.get(id) ?? null, fallback } : null;
}

/**
 * The version a screenshot taken at `at` shows: the newest saved by then, or the first.
 * @param {{ v: number, at: number, intent?: string }[]} versions @param {number} at
 */
export const versionAt = (versions, at) => versions.findLast((v) => v.at <= at) ?? versions[0] ?? null;

/** What the judge is asked, with the takeaway already written. @param {string} intent @param {string} takeaway */
export function matchPrompt(intent, takeaway) {
  return `An agent drew a picture to answer someone. Before drawing, it said what the picture should leave the reader with:
“${intent}”

A reader who saw only the picture, and not that sentence, said it tells them:
“${takeaway}”

Does the reader’s takeaway carry the agent’s intent? yes: the same point, in other words or with more. partly: some of it, or the subject without the point. no: a different point, or none. Judge the point, not the wording.`;
}

/** The report’s cell for a version’s intent. @param {{ intent?: string|null, intentV?: number }} visual */
export function intentCell(visual) {
  if (visual.intent === undefined || visual.intent === null) return 'not an app';
  if (!visual.intent) return `none: v${visual.intentV} had no intent`;
  const n = wordCount(visual.intent);
  return n > LIMITS.appIntentWords ? `${visual.intent} (${n} words, over ${LIMITS.appIntentWords})` : visual.intent;
}

/**
 * Adds each judged visual’s intent, and whether the takeaway matches it, to its timeline entry. A visual that isn’t an
 * app, or whose version has no intent, gets no match.
 * @param {{ timeline: any[], data: string, shots: string, keys: Map<string, string>, ask: (args: any) => Promise<{ value: any, cost: number }>, model: string, log: (line: string) => void }} o
 *   Each comparison runs in an empty folder of its own: it needs only the two sentences.
 * @returns {Promise<number>} what the judge spent
 */
export async function matchIntents({ timeline, data, shots, keys, ask, model, log }) {
  let spent = 0;
  for (const t of timeline.filter((x) => x.visual)) {
    const v = t.visual;
    const app = appAt(data, keys.get(v.item) ?? '');
    if (!app) continue;
    const shot = shotAtStep(shots, v.item, t.step);
    const version = versionAt(app.versions, shot?.at ?? Number.POSITIVE_INFINITY);
    Object.assign(v, { intent: version?.intent ?? '', intentV: version?.v ?? null });
    if (!v.intent) continue;
    try {
      const prompt = matchPrompt(v.intent, String(v.takeaway));
      const r = await inOwnFolder({}, (cwd) => ask({ cwd, model, prompt, schema: MATCH_SCHEMA, budgetUsd: 0.5 }));
      spent += r.cost;
      Object.assign(v, { match: r.value.match, matchWhy: r.value.why });
    } catch (e) {
      spent += e.cost ?? 0;
      log(`Couldn’t compare ${v.item}’s takeaway with its intent: ${e.message}`);
    }
  }
  return spent;
}
