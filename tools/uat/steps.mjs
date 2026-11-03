// The tester’s actions that live in modules of their own, by type: tools/uat-run.mjs runs each with what it needs
// ({ d, page, api, keys, facts, step }) and the action, and says what it returns. One table, so a new one costs the
// runner, which is at its size, no lines.

import { goToNeedsStep } from './driver-needs.mjs';

export const STEPS = Object.freeze({ go_to_needs: goToNeedsStep });
