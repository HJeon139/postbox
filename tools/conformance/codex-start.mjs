// Codex, start (#585): does Codex save the guide Postbox gives thread/start? With no model turn: thread/start, then
// thread/inject_items, which makes Codex write the rollout. The rollout must hold the marker exactly once, in a
// developer message that holds the whole guide. Then a resume in a new process, with the same guide, and another injected item: still once.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAppServer } from './app-server.mjs';
import { baseConfigToml } from './codex-config.mjs';
import { openThread } from './codex-open.mjs';
import { markedGuide, newMarker, withProbeHome } from './probe-home.mjs';
import { recordTo, scrubRollout } from './record.mjs';
import { rolloutFiles, savedMarkers } from './rollout.mjs';
import { sandboxEnv } from './sandbox-env.mjs';

const ITEM_TEXT = 'Postbox conformance probe item.';
const ITEM = { type: 'message', role: 'user', content: [{ type: 'input_text', text: ITEM_TEXT }] };

/** @typedef {{ files: number, developer: number, elsewhere: number, whole: number }} Saved */

/** Whether the counts are the whole guide saved once, as a developer message. @param {Saved} c */
export const savedOnce = (c) => c.files === 1 && c.developer === 1 && c.elsewhere === 0 && c.whole === 1;

/** Says what the counts show. @param {Saved} c */
const said = (c) => `${c.files} rollout file(s), marker ${c.developer}× in developer messages, ${c.elsewhere}× elsewhere, the whole guide in ${c.whole}`;

/**
 * `record`: a folder to write the rollout into, as guide-rollout.jsonl, through record.mjs’s allowlist.
 * @param {{ bin: string, record?: string }} opts
 */
export function codexStartCheck({ bin, record }) {
  return withProbeHome(async ({ home, codexHome }) => {
    const marker = newMarker('start');
    const guide = markedGuide('codex', marker);
    const env = sandboxEnv({ home, codexHome });
    await writeFile(join(codexHome, 'config.toml'), baseConfigToml());
    let server = await openAppServer({ bin, cwd: home, env });
    let threadId;
    try {
      threadId = (await openThread(server.request, { cwd: home, guide })).thread.id;
      await server.request('thread/inject_items', { threadId, items: [ITEM] });
    } finally {
      await server.stop();
    }
    const started = await savedMarkers(codexHome, marker, guide);
    server = await openAppServer({ bin, cwd: home, env });
    try {
      await openThread(server.request, { cwd: home, guide, sourceThreadId: threadId });
      await server.request('thread/inject_items', { threadId, items: [ITEM] });
    } finally {
      await server.stop();
    }
    const resumed = await savedMarkers(codexHome, marker, guide);
    const [rollout] = await rolloutFiles(codexHome);
    if (record && rollout) {
      const keep = (/** @type {string} */ text) => text === guide || text === ITEM_TEXT; // exactly the probe’s own texts
      await recordTo(record, 'guide-rollout.jsonl', scrubRollout(await readFile(rollout, 'utf8'), keep));
    }
    return [
      { name: 'start saves the guide once', ok: savedOnce(started), detail: said(started) },
      { name: 'a resume keeps it once', ok: savedOnce(resumed), detail: said(resumed) },
    ];
  });
}
