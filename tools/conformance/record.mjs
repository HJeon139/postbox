// Records the Codex conformance fixtures (#585) from a probe’s own run: `node tools/backend-conformance.mjs codex
// --record <folder>`. What’s kept is an allowlist, as tools/record-claude-once.mjs’s is: each rollout line’s type,
// its message items’ type, role and order, and Codex’s version; each request’s model and input items. A text is kept
// only when the probe wrote it (the guide, with its marker, and the probe’s own message); every other text, Codex’s
// own, becomes “[cut: N characters of Codex’s own text]”. Ids, folders, timestamps and every other field are left out.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {string} text */
const cut = (text) => `[cut: ${text.length} characters of Codex’s own text]`;

/**
 * A Responses input item, or a rollout line’s item, as the fixture keeps it: a message’s type, role and parts, each
 * part’s text kept when `keep` says the probe wrote it; any other item’s type alone.
 * @param {any} item @param {(text: string) => boolean} keep
 */
export function keptItem(item, keep) {
  if (item?.type !== 'message') return { type: typeof item?.type === 'string' ? item.type : null };
  const parts = Array.isArray(item.content) ? item.content : [];
  return {
    type: 'message',
    role: typeof item.role === 'string' ? item.role : null,
    content: parts.map((/** @type {any} */ part) => {
      const text = typeof part?.text === 'string' ? part.text : '';
      return { type: typeof part?.type === 'string' ? part.type : null, text: keep(text) ? text : cut(text) };
    }),
  };
}

/** Any other line’s payload: Codex’s version alone, where the line names it. @param {any} payload */
function keptMeta(payload) {
  if (typeof payload?.cli_version !== 'string') return {};
  return { cli_version: payload.cli_version };
}

/**
 * A rollout file’s text as the fixture keeps it, one JSON object a line. A line that isn’t JSON is left out.
 * @param {string} text @param {(text: string) => boolean} keep
 */
export function scrubRollout(text, keep) {
  const lines = [];
  for (const raw of text.split('\n')) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // an empty or half-written line
    }
    const payload = line?.payload ?? {};
    const kept = line?.type === 'response_item' ? keptItem(payload, keep) : keptMeta(payload);
    lines.push(JSON.stringify({ type: typeof line?.type === 'string' ? line.type : null, payload: kept }));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A Responses request body as the fixture keeps it: its model and its input items.
 * @param {any} body @param {(text: string) => boolean} keep
 */
export const scrubRequest = (body, keep) => ({
  model: typeof body?.model === 'string' ? body.model : null,
  input: (Array.isArray(body?.input) ? body.input : []).map((/** @type {any} */ item) => keptItem(item, keep)),
});

/** Writes one fixture file into `folder`. @param {string} folder @param {string} name @param {string} text */
export async function recordTo(folder, name, text) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name), text);
}
