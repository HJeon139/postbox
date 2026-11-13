// The models Claude Code and the Agent SDK offer, asked of the signed-in CLI itself, so Postbox keeps no list of
// Claude’s models of its own: the model field suggests what this sign-in runs. Each runs no model.

import { claudeModelIds } from '../../shared/model-ids.mjs';
import { LIST_TIMEOUT_MS } from '../remote/host/harness-models.mjs';

export { claudeModels } from '../remote/host/harness-models.mjs';

/**
 * The Agent SDK’s models, from a query that’s sent no message: its supportedModels(), then the query is closed.
 * Empty if it fails.
 * @param {{ query: Function }} sdk
 * @returns {Promise<string[]>}
 */
export async function sdkModels(sdk) {
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  // The query’s input: it sends nothing, and ends when the query is closed.
  const nothing = { [Symbol.asyncIterator]: () => ({ next: () => held.then(() => ({ done: true, value: undefined })) }) };
  /** @type {any} */
  let q = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    q = sdk.query({ prompt: nothing, options: {} });
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The Agent SDK didn’t list its models in time.')), LIST_TIMEOUT_MS);
      timer.unref?.();
    });
    return claudeModelIds(await Promise.race([q.supportedModels(), late]));
  } catch {
    return []; // Not signed in, or the SDK’s CLI didn’t start: the model field says it couldn’t list.
  } finally {
    clearTimeout(timer);
    release();
    q?.close();
  }
}
