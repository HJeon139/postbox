// Agents on a scripted backend, for the live view’s specs (tests/browser/live-*.spec.mjs). They report through the
// harness-event contract (server/harness-events.mjs) from scripts the test holds at each stage, as the mock backend’s
// do, so a stage can be looked at while the turn still runs.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessEvents } from '../../server/harness-events.mjs';
import { failOnPageErrors, startPostbox } from './postbox.mjs';

/**
 * A Postbox of the spec file’s own with the scripted backend, its hooks registered on `test`.
 * @param {any} test  Playwright’s test @param {string} name
 */
export function scriptedRoom(test, name) {
  /** @type {Map<string, { stage: number, go: () => void }>} where each agent’s script waits */
  const holds = new Map();
  let project;
  const live = {
    /** @type {Awaited<ReturnType<typeof startPostbox>>} */
    app: /** @type {any} */ (null),
    /** @type {Map<string, (step: any) => Promise<void>>} each agent’s script, by its handle */
    scripts: new Map(),
    /** How far a script moved its harness’s clock on, in milliseconds, so time passes without a wait. */
    ahead: 0,
    /** Waits in a script until the test says go, noting the stage it waits at. */
    hold: (/** @type {string} */ who, /** @type {number} */ stage) =>
      new Promise((r) => {
        holds.set(who, { stage, go: () => r(undefined) });
      }),
    go: (/** @type {string} */ who) => holds.get(who)?.go(),
    at: (/** @type {string} */ who) => holds.get(who)?.stage ?? -1,
    /** A room of agents on the scripted backend. @param {string} title @param {string[]} handles */
    room(title, handles) {
      const ids = handles.map((handle) => live.app.rt.createPersona({ handle, backend: 'claude-code', model: 'claude-haiku-5-5' }).id);
      return live.app.rt.createThread({ projectId: project.id, title, personaIds: ids });
    },
    /** An edit the agent makes for real, so the work ledger records it, reported as Claude Code reports it. */
    async edit(/** @type {any} */ emit, /** @type {string} */ id, /** @type {string} */ file, /** @type {string} */ from, /** @type {string} */ to) {
      const path = join(live.app.root, file);
      const input = { file_path: path, old_string: from, new_string: to };
      emit({ kind: 'tool_call', id, name: 'Edit', input, final: true });
      const before = await readFile(path, 'utf8');
      await writeFile(path, before.replace(from, to));
      emit({ kind: 'tool_result', id, text: 'ok', result: { originalFile: before } });
    },
  };
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeAll(async () => {
    live.app = await startPostbox(name);
    live.app.rt.adapters.register({
      name: 'claude-code',
      async folderFor() {
        return live.app.root;
      },
      async deliver(/** @type {any} */ session, /** @type {any} */ message, /** @type {any} */ ctx) {
        // Postbox’s lint turn after each reply isn’t the agent’s work: running the script again for it would double
        // what a spec counts, by how slowly the page catches up (CI run 43176907674).
        if (message.kind === 'lint') return;
        const emit = new HarnessEvents(ctx, { now: () => Date.now() + live.ahead }).event;
        await live.scripts.get(session.handle)?.({ emit, who: session.handle });
      },
    });
    project = Object.values(live.app.store.state.projects)[0];
  });
  test.afterAll(async () => {
    for (const h of holds.values()) h.go();
    await live.app?.stop();
  });
  failOnPageErrors(test);
  return live;
}
