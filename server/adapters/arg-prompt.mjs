// A prompt passed to a backend as one command-line argument (#362): Linux refuses one argument past 128 KiB
// (MAX_ARG_STRLEN) with E2BIG, so a backend that has no other way in for a prompt refuses a longer one with a reason.

import { ARG_PROMPT_MAX } from '../../shared/limits.mjs';

/** Whether a prompt is too long for one argument. @param {string} prompt */
export const tooLongForArg = (prompt) => Buffer.byteLength(prompt) > ARG_PROMPT_MAX;

/**
 * Why a prompt can't go to `backend` as one argument, or null when it can.
 * @param {string} prompt @param {string} backend  as the person reads it, such as “the Antigravity CLI”
 */
export function promptTooLong(prompt, backend) {
  if (!tooLongForArg(prompt)) return null;
  const kb = (n) => Math.ceil(n / 1000);
  return `This message is ${kb(Buffer.byteLength(prompt))} KB, past the ${kb(ARG_PROMPT_MAX)} KB ${backend} can take as its prompt. Send it in parts, or point the agent at a file that holds the rest.`;
}
