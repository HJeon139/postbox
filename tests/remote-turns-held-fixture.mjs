// The rig for a remote turn’s writes behind a held commit (#623; tests/remote-turns-held*.test.mjs): the remote rig of
// tests/remote-turns-helpers.mjs, on a store whose commit can be held (tests/stop-reply-fixture.mjs, heldStore).

import { after } from 'node:test';
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
  /** @type {(() => Promise<void>) | null} */
  let open = null;
  const hold = async () => {
    h.hold();
    const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
    await h.atSync;
    const release = async () => {
      open = null;
      h.release();
      await commit;
      await h.store.flush();
    };
    open = release;
    return release;
  };
  /** @type {Promise<unknown> | null} */
  let closed = null;
  // Closed once, at the test’s end or the file’s, so a failed assertion doesn’t leave the store open; a commit it
  // left held is let through first, or the close would wait out its bound on that disk step.
  const close = () => (closed ??= (async () => (open ? open() : undefined))().finally(() => h.store.close()));
  after(close);
  return { ...r, hold, close };
}

/** The session’s remoteTurn as published. @param {any} r */
export const remoteTurn = (r) => r.store.state.sessions[r.se().id].remoteTurn;
