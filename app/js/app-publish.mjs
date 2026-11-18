// An app’s postbox.publish, sent to the server (#1478, server/app-publish.mjs). An app may publish on every keystroke
// or drag, and only its latest data matters to its agent, so each app’s publishes wait PUBLISH_MS and the latest goes:
// at most one request per app in that time, and each after the one before it has its answer, so the server keeps them
// in the order the app made them. Every publish of a burst answers with the answer to the one that went.

import { api } from './client.mjs';
import { inOrder } from './send-chain.mjs';

/** How long an app’s publishes gather before the latest goes: saveState’s wait too. */
export const PUBLISH_MS = 400;

/** Each app’s publish waiting to go: its latest data, and the callers waiting on it. @type {Map<string, any>} */
const waiting = new Map();

/** Publishes an app’s data, latest first. @param {string} appId @param {unknown} data @returns {Promise<any>} */
export function publishLater(appId, data) {
  return new Promise((resolve, reject) => {
    let next = waiting.get(appId);
    if (!next) {
      next = { data, callers: [] };
      waiting.set(appId, next);
      setTimeout(() => send(appId), PUBLISH_MS);
    }
    next.data = data;
    next.callers.push({ resolve, reject });
  });
}

/** Sends an app’s latest publish after the one before it: inOrder’s chain, under a key no app id can be. @param {string} appId */
function send(appId) {
  const { data, callers } = waiting.get(appId);
  waiting.delete(appId);
  inOrder(`publish ${appId}`, () => api(`/api/apps/${encodeURIComponent(appId)}/publish`, { data })).then(
    (r) => {
      for (const c of callers) c.resolve(r);
    },
    (err) => {
      for (const c of callers) c.reject(err);
    },
  );
}
