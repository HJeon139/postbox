// How the last turn with each model ended, for each backend here and on each host (#1977). A harness lists the models
// it knows, not the ones this sign-in or account may run, and nothing but a turn says which those are: on a host
// whose models were Amazon Bedrock’s, the first model listed was refused and so was the next the person picked. So
// Postbox keeps what each turn showed, and the Model field orders and marks its suggestions by it
// (app/js/model-field.mjs). A record is a fact about one past turn, never a promise about the next.
//
// It is kept in the data folder beside the lists themselves (server/model-lists.mjs), by the same key: a backend’s
// name, or `backend@hostId`. It is read from a turn’s structured end, whether it failed and whether it took a step,
// never from the words of its error, which are kept only to show.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isModelId, MAX_MODELS } from '../shared/model-ids.mjs';
import { cutText } from '../shared/text-parts.mjs';
import { modelOf } from './adapters/setup.mjs';
import { failureClass } from './harness-failure.mjs';

/** The most of a harness’s own words kept with a model its turn failed on. */
const WHY_MAX = 300;

/**
 * How a model’s last turn ended: it answered, or it failed before its first step, with what the harness said.
 * @typedef {{ ended: 'answered' | 'failed', at: number, why?: string }} ModelRun
 */

/** The agent’s own steps: not a subagent’s, a thought or narration (server/turn-held.mjs counts them the same). */
const ownSteps = (/** @type {any} */ turn) => (turn.steps ?? []).filter((/** @type {any} */ s) => !s.who && s.kind !== 'thought' && s.kind !== 'said').length;

/**
 * Whether a failed turn says something about its model: it failed before the agent took a step or said a word, and
 * not for a reason that is the network’s, the quota’s or a provider’s passing failure, each of which Postbox already
 * names and acts on (server/harness-failure.mjs).
 * @param {any} turn @param {{ lost?: boolean, resends?: boolean }} how
 */
const failedAtItsModel = (turn, { lost, resends }) =>
  !lost && !resends && !failureClass(turn.endErr) && ownSteps(turn) === 0 && !String(turn.said ?? '').trim();

export class ModelRuns {
  /**
   * @param {{ file: string, now?: () => number, hostIds?: () => string[] }} opts  file: where the records are kept;
   *   hostIds: the hosts Postbox has, so a deleted one’s records are forgotten
   */
  constructor({ file, now = Date.now, hostIds }) {
    this.file = file;
    this.now = now;
    this.hostIds = hostIds;
    /** Whether Postbox has closed, after which nothing is kept, as the lists do (#1530). */
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  /**
   * Listens for the end of each turn. A turn that ended with a reply says its model answered; one that failed before
   * its first step says so, with the harness’s words. The mock runs no model.
   * @param {any} rt
   */
  listen(rt) {
    const where = (/** @type {any} */ turn, /** @type {any} */ se) => {
      const persona = rt.s.personas?.[se.personaId];
      if (!persona || persona.backend === 'mock') return null;
      const hostId = turn.remote?.hostId ?? persona.remote?.hostId ?? null;
      return { key: hostId ? `${persona.backend}@${hostId}` : persona.backend, model: modelOf(persona) };
    };
    rt.bus.on('turn.ended', ({ turn, se }) => {
      const ran = where(turn, se);
      if (ran) this.record(ran.key, ran.model, 'answered');
    });
    rt.bus.on('turn.failed', ({ turn, se, lost, resends }) => {
      const ran = where(turn, se);
      if (ran && failedAtItsModel(turn, { lost, resends })) this.record(ran.key, ran.model, 'failed', turn.endErr?.userMessage ?? turn.endErr?.message);
    });
  }

  /**
   * Keeps how a model’s turn ended. An answer after an answer changes nothing, so a room that runs all day writes
   * once; a failure is kept each time, with when, since the person reads how old it is.
   * @param {string} key  a backend’s name, or `backend@hostId` @param {string} model
   * @param {'answered' | 'failed'} ended @param {unknown} [why]  the harness’s own words for a failure
   */
  record(key, model, ended, why) {
    if (this.closed || !isModelId(model)) return;
    const kept = this.#kept();
    const of = { ...(Object.hasOwn(kept, key) ? kept[key] : {}) };
    if (ended === 'answered' && of[model]?.ended === 'answered') return;
    of[model] = { ended, at: this.now(), ...(ended === 'failed' && why ? { why: cutText(String(why), WHY_MAX) } : {}) };
    // The newest MAX_MODELS: a model nobody has run in a long while is a suggestion like any other again.
    const newest = Object.entries(of)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_MODELS);
    this.#keep({ ...kept, [key]: Object.fromEntries(newest) });
  }

  /**
   * What is kept for a backend here, or on a host. @param {string} backend @param {string | null} [hostId]
   * @returns {Record<string, ModelRun>}
   */
  of(backend, hostId = null) {
    const kept = this.#kept();
    const key = hostId ? `${backend}@${hostId}` : backend;
    return Object.hasOwn(kept, key) ? kept[key] : {};
  }

  /** Keeping it is for the next sheet and the next start: a write that fails is logged, and the turn goes on. */
  #keep(/** @type {Record<string, Record<string, ModelRun>>} */ kept) {
    try {
      // A deleted host’s records go: no agent runs there again.
      const hosts = this.hostIds?.();
      if (hosts) for (const k of Object.keys(kept)) if (k.includes('@') && !hosts.includes(k.slice(k.indexOf('@') + 1))) delete kept[k];
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(kept)}\n`);
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(
        `Postbox couldn’t keep how a model’s turn ended in ${this.file}: ${e instanceof Error ? e.message : e}. The Model field shows what it had.`,
      );
    }
  }

  /** @returns {Record<string, Record<string, ModelRun>>} */
  #kept() {
    try {
      const kept = JSON.parse(readFileSync(this.file, 'utf8'));
      return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    } catch {
      return {}; // None kept yet, or a file that isn’t ours to read: every model is one nobody has tried.
    }
  }
}
