// The models Claude Code and the Agent SDK offer, asked of the signed-in CLI itself, so Postbox keeps no list of
// Claude’s models of its own: the model field suggests what this sign-in runs. Each runs no model.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** How long a listing may take before it counts as failed. */
const LIST_TIMEOUT_MS = 15_000;
/** A model id as the CLI takes it in --model: claude-opus-5-5, or one with a context suffix such as claude-opus-5-5[1m]. */
const MODEL_ID = /^[\w.:[\]-]{1,80}$/;

/**
 * The ids in the CLI’s model rows (the SDK’s ModelInfo), in its order, once each and bounded. An alias row
 * (“default”, “opus”) counts as the id it resolves to, so a persona never names an alias your own settings decide (#60).
 * @param {unknown} rows
 * @returns {string[]}
 */
export function modelIdsOf(rows) {
  if (!Array.isArray(rows)) return [];
  const ids = rows.map((m) => m?.resolvedModel ?? m?.value).filter((id) => typeof id === 'string' && MODEL_ID.test(id));
  return [...new Set(ids)].slice(0, 60);
}

/**
 * Claude Code’s models: `claude -p` in stream-json, asked with an initialize request and nothing else, then stopped.
 * Empty if it fails.
 * @param {string} bin @param {{ spawnImpl?: typeof spawn }} [opts]
 * @returns {Promise<string[]>}
 */
export function claudeModels(bin, { spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    const lines = createInterface({ input: child.stdout });
    const finish = (/** @type {string[]} */ models) => {
      clearTimeout(timer);
      lines.close();
      child.kill('SIGTERM');
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), LIST_TIMEOUT_MS);
    timer.unref?.();
    lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // Not one of the stream’s JSON lines: the answer is a line of its own.
      }
      if (msg?.type === 'control_response' && msg.response?.request_id === 'models')
        finish(msg.response.subtype === 'success' ? modelIdsOf(msg.response.response?.models) : []);
    });
    child.on('error', () => finish([]));
    child.on('close', () => finish([]));
    child.stdin.on('error', () => {}); // A CLI that exited first closes stdin; its close event answers.
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`);
  });
}

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
    return modelIdsOf(await Promise.race([q.supportedModels(), late]));
  } catch {
    return []; // Not signed in, or the SDK’s CLI didn’t start: the model field says it couldn’t list.
  } finally {
    clearTimeout(timer);
    release();
    q?.close();
  }
}
