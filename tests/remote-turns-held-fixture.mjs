// The rig for a remote turn’s writes behind a held commit (#623; tests/remote-turns-held*.test.mjs): the remote rig of
// tests/remote-turns-helpers.mjs, on a store whose commit can be held (tests/stop-reply-fixture.mjs, heldStore).

import { rig } from './remote-turns-helpers.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

/**
 * The remote rig on a store whose commit can be held; `hold` returns the release that lets it, and what it held, through.
 * @param {Parameters<typeof rig>[0]} [o]  the rig’s other options
 */
export async function heldRig(o = {}) {
  const h = await heldStore();
  const r = rig({ ...o, store: h.store });
  await h.store.flush();
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    return async () => {
      h.release();
      await commit;
      await h.store.flush();
    };
  };
  return { ...r, hold, close: () => h.store.close() };
}

/** The session’s remoteTurn as published. @param {any} r */
export const remoteTurn = (r) => r.store.state.sessions[r.se().id].remoteTurn;
