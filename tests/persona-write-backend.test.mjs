// A persona switched to another backend (server/personas.mjs, updatePersona, #1315): its sessions drop the model
// and effort the old backend reported, so the agent’s row shows the new setting, not “Opus 5.5, not auto”, until the
// new backend reports its own. Kiro on its router reports neither, so without this the old ones stayed for good.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { chipEffort, chipModel, runsWith } from '../shared/agent-facts.mjs';
import { tempDir } from './temp-dirs.mjs';

/** @alpha on `backend` in a conversation, whose last turn reported Opus at medium. */
function setup(backend = 'claude-code') {
  const workRoot = join(tempDir('pb-persona-backend-'), 'workspaces');
  const adapters = new AdapterRegistry()
    .register(new ClaudeCodeAdapter({ bin: 'claude', workRoot }))
    .register(new CodexAdapter({ bin: 'codex', workRoot }))
    .register(new KiroCliAdapter({ bin: 'kiro-cli', workRoot }));
  const store = new Store(null);
  const rt = new Runtime({ store, adapters, config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 } });
  store.emit('project', { id: 'p1', name: 'P', folder: tempDir('pb-persona-backend-project-') });
  const p = rt.createPersona({ handle: 'alpha', backend, model: 'claude-opus-5-5', effort: 'medium' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const [se] = rt.sessionsIn(t.id);
  rt.updateSession(se.id, { lastModel: 'claude-opus-5-5', lastEffort: 'medium' });
  const row = () => {
    const f = runsWith(rt.s.sessions[se.id], rt.personaByHandle('alpha'), {});
    return `${chipModel(f)} · ${chipEffort(f)}`;
  };
  return { rt, p, se, row };
}

test('#1315: switched to another backend, an agent’s row shows the new setting, not the model the old backend reported', () => {
  const { rt, p, row } = setup();
  rt.updatePersona(p.id, { backend: 'codex', model: 'auto', effort: 'high' });
  assert.equal(row(), 'Codex’s default · high effort');
  rt.updatePersona(p.id, { backend: 'claude-code', model: 'claude-sonnet-5-5', effort: 'low' });
  assert.equal(row(), 'Sonnet 5.5 · low effort');
});

test('#1315: a change of model on the same backend drops what its last turn reported, since the new one may report nothing', () => {
  // Kiro reports no model or effort on its router, so an Opus report would stay on its row for good.
  const { rt, p, row } = setup('kiro-cli');
  rt.updatePersona(p.id, { model: 'auto', effort: 'high' });
  assert.equal(row(), 'auto · high effort');
});

test('#1315: a change of effort alone keeps what its last turn reported, marked until the next turn', () => {
  const { rt, p, row } = setup();
  rt.updatePersona(p.id, { effort: 'low' });
  assert.equal(row(), 'Opus 5.5 · medium effort, set to low');
});
