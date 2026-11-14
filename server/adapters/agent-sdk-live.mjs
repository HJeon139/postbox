// What the person can change while an Agent SDK turn runs (#66, #67, #806), and the SDK’s names for Postbox’s
// permission modes. Moved out of server/adapters/agent-sdk.mjs.

import { switchesLive } from '../../shared/hook-modes.mjs';

// Passed explicitly, as for the CLI: an agent set to ask must not inherit a looser mode from your settings.
export const MODES = { auto: 'auto', ask: 'default', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' };

/**
 * What the person can change while a turn runs: the permission mode (#66), the model and the effort (#67), with the
 * running query’s setPermissionMode, setModel and applyFlagSettings({ effortLevel }). The SDK documents them for
 * streaming input only, and Postbox sends a turn’s prompt as one string, so each change is tried, and resolves to
 * whether it took effect now; if not, it applies from the next turn, since all three are passed with every turn. A turn
 * that loaded the person’s hooks keeps its mode rather than switch into one that turns them off (switchesLive, #806).
 * @param {any} q  the running query  @param {string} [started]  the Postbox mode the turn started in
 */
export function liveControl(q, started = 'auto') {
  return {
    /** @param {string} mode  one of Postbox’s modes */
    async setPermissionMode(mode) {
      if (!switchesLive(started, mode) || typeof q?.setPermissionMode !== 'function' || !Object.hasOwn(MODES, mode)) return false;
      try {
        await q.setPermissionMode(MODES[/** @type {keyof typeof MODES} */ (mode)]);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} model */
    async setModel(model) {
      if (typeof q?.setModel !== 'function') return false;
      try {
        await q.setModel(model);
        return true;
      } catch {
        return false;
      }
    },
    /** @param {string} effort  one of EFFORT_LEVELS */
    async setEffort(effort) {
      if (typeof q?.applyFlagSettings !== 'function') return false;
      try {
        await q.applyFlagSettings({ effortLevel: effort });
        return true;
      } catch {
        return false;
      }
    },
  };
}
