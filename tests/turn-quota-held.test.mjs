// A quota is its backend’s on the computer that runs it (#442; server/turn-quota.mjs), so whose quota an agent’s turns
// use is read from its persona as written: a move held behind a commit counts at once, as Placement’s noteAttach reads
// it (designs/architecture/services.md, “Running”). Read published, an agent just moved to a host was still marked
// with this computer’s quota.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outOfQuota } from '../server/turn-quota.mjs';
import { setup } from './side-threads-fixture.mjs';
import { heldStore } from './stop-reply-fixture.mjs';

test('#442 an agent moved to a host behind a held commit isn’t marked with this computer’s quota', async () => {
  const h = await heldStore();
  const f = setup(h.store);
  await h.store.flush();
  h.hold();
  const commit = h.store.commit([{ type: 'settings', data: { theme: 'system' } }]);
  await h.atSync;
  const persona = h.store.pending.persona(f.beta.personaId);
  h.store.emit('persona', { ...persona, remote: { hostId: 'h1' }, version: (persona.version ?? 1) + 1 });
  const alpha = h.store.pending.session(f.alpha.id);
  f.rt.sessions.update(alpha.id, { state: 'failed', quota: outOfQuota(f.rt, alpha, null, f.t.id) });
  assert.equal(h.store.pending.session(f.beta.id).quota ?? null, null, 'beta runs on h1 now');
  h.release();
  await commit;
  await h.store.flush();
});
