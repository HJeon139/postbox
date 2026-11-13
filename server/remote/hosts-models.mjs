// Asking a host which models its own CLI for a harness offers (#1304): `models`, answered by `listed`
// (shared/remote-protocol.mjs). server/model-lists.mjs calls it when the Model field opens for an agent that runs
// there. It uses only the host manager’s own methods (hosts.mjs), and keeps the host connected while it waits.

import { message } from '../../shared/remote-protocol.mjs';
import { LIST_TIMEOUT_MS } from './host/harness-models.mjs';

/** How long Postbox waits for `listed` once `models` is sent: the host’s own listing limit, plus the round trip. */
export const LISTED_WAIT_MS = LIST_TIMEOUT_MS + 30_000;

/**
 * Why a host gave no list: it couldn’t be reached; its daemon is older than `models`, so installing this version
 * there would let it list; or it answered without one (its CLI isn’t there, or couldn’t list).
 * @typedef {'unreachable' | 'outdated' | 'not-listed'} NotListed
 */

/**
 * The models the host’s CLI for a harness lists. Rejects with an Error whose code is a NotListed, or the manager’s
 * `no-host` for a host that doesn’t exist.
 * @param {any} hosts  the host manager (hosts.mjs) @param {string} hostId @param {string} harness
 * @param {{ setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [o]
 * @returns {Promise<string[]>}
 */
export async function hostModels(hosts, hostId, harness, { setTimer = (fn, ms) => setTimeout(fn, ms).unref(), clearTimer = clearTimeout } = {}) {
  const why = Symbol('model list');
  hosts.need(hostId, why);
  try {
    try {
      await hosts.ensureWelcome(hostId);
    } catch (e) {
      if (e?.code === 'no-host') throw e;
      throw notListed('unreachable', `Postbox couldn’t reach the host: ${e?.message ?? e}`);
    }
    const listed = await new Promise((resolve, reject) => {
      const l = hosts.link(hostId);
      let timer = null;
      /** @param {(v: any) => void} fn @param {any} v */
      const done = (fn, v) => {
        if (timer) clearTimer(timer);
        l.off('message', onMessage);
        l.off('state', onState);
        fn(v);
      };
      const onMessage = (msg) => {
        if (msg.type === 'listed' && msg.harness === harness) done(resolve, msg.models);
        // A daemon from before `models` refuses the line as a message it doesn’t know, naming no request
        // (tests/fixtures/remote/models-before-1312.json). One that has `models` refuses it naming it, as while it’s
        // being removed.
        else if (msg.type === 'error' && msg.code === 'bad-message' && !msg.re) done(reject, notListed('outdated', msg.message));
        else if (msg.type === 'error' && msg.re === 'models') done(reject, notListed('not-listed', msg.message));
      };
      const onState = () => !l.connected && done(reject, notListed('unreachable', 'The connection closed before the host listed its models.'));
      l.on('message', onMessage);
      l.on('state', onState);
      timer = setTimer(() => done(reject, notListed('unreachable', 'The host didn’t list its models in time.')), LISTED_WAIT_MS);
      if (!l.send(message('postbox-to-daemon', 'models', { harness }))) done(reject, notListed('unreachable', 'Postbox couldn’t send to the host.'));
    });
    if (!listed.length) throw notListed('not-listed', 'The host’s CLI listed no models.');
    return listed;
  } finally {
    hosts.release(hostId, why);
  }
}

/** @param {NotListed} code @param {string} text */
const notListed = (code, text) => Object.assign(new Error(text), { code });
