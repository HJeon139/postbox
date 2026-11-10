// A prompt passed to a backend as one command-line argument (#362). Linux refuses one argument past 128 KiB
// (MAX_ARG_STRLEN) and macOS allows about 1 MiB in all, both with E2BIG. Kiro has stdin for a long prompt, on every
// system. agy has no other way in, so its turn is tried, and a real E2BIG tells the person why it didn’t start.

import { ARG_PROMPT_MAX } from '../../shared/limits.mjs';

/** Whether a prompt goes another way than one argument, for a backend that has one. @param {string} prompt */
export const tooLongForArg = (prompt) => Buffer.byteLength(prompt) > ARG_PROMPT_MAX;

/**
 * What the person reads when the operating system refused a prompt as too long for `backend`.
 * @param {string} prompt @param {string} backend  as the person reads it, such as “the Antigravity CLI”
 */
export function promptTooLong(prompt, backend) {
  const kb = Math.ceil(Buffer.byteLength(prompt) / 1000);
  // The prompt is more than the person's message: the catch-up and queued messages come with it.
  return `This turn’s prompt came to ${kb} KB, too long for this computer to pass to ${backend}. It holds your message, the room’s catch-up and any queued messages: send a shorter message, or point the agent at a file that holds the rest.`;
}
