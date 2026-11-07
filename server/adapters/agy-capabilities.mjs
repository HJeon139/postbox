// What the Antigravity CLI backend can do, as adapter.mjs’s capabilities say, moved out of antigravity-cli.mjs under
// the file-length rule. antigravity-cli.mjs re-exports it.

import { HOOK_PROMPTS } from './agy-hook.mjs';

/** What this backend can do, for the runtime and the UI (#117, #370). The adapter adds the models it found. */
export const AGY_CAPABILITIES = Object.freeze({
  resume: true,
  fork: false,
  permissions: 'none',
  tools: 'none',
  isolation: false,
  // Postbox’s skills only, in the turn’s plugin (agy-plugin.mjs): the sheet lists those (#207).
  skills: 'postbox',
  ...HOOK_PROMPTS,
});
