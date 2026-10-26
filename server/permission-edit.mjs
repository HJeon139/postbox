// A permission card’s Edit (#10), for server/permission-cards.mjs: the input an edited answer allows, checked.

import { httpError } from './helpers.mjs';

// The input it starts from, and what you can send back, are bounded.
export const MAX_EDIT_INPUT = 16000;
export const MAX_REASON = 1000;
/**
 * The input an edited permission answer allows: the command you changed, for Bash, else the input you rewrote (an
 * object, or JSON that parses to one). Refused when it doesn’t parse, so a typo never reaches the agent’s tool.
 * @param {any} it @param {Record<string, any>} values
 */
export function editedInput(it, values) {
  // Edit starts from the call’s whole input. One too large to keep on the card can only be allowed as it is, since an
  // edit made from its shortened text would drop the rest (a command’s description, timeout or background flag).
  if (!it.input) throw httpError(409, 'This call’s input is too large to edit here. Allow it as it is, or don’t allow it and say what to do instead.');
  if (it.tool === 'Bash' && typeof values?.command === 'string') {
    const command = values.command.trim();
    if (!command) throw httpError(422, 'Write the command to run, or choose Don’t allow.');
    if (command.length > MAX_EDIT_INPUT) throw httpError(422, `A command is limited to ${MAX_EDIT_INPUT.toLocaleString('en-US')} characters.`);
    return { ...it.input, command };
  }
  let input = values?.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch (e) {
      throw httpError(422, `The edited input isn’t valid JSON: ${e.message}`);
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw httpError(422, 'The edited input has to be a JSON object, like the one it started from.');
  if (JSON.stringify(input).length > MAX_EDIT_INPUT)
    throw httpError(422, `The edited input is limited to ${MAX_EDIT_INPUT.toLocaleString('en-US')} characters.`);
  return input;
}
