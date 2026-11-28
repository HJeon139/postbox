// A conformance probe’s temp folders (#585): a HOME and, for Codex, a CODEX_HOME inside it, removed when it ends, so
// no probe reads or writes the person’s own config.

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentGuide } from '../../server/adapters/guide.mjs';

/**
 * Runs `fn` with a fresh temp HOME (and CODEX_HOME under it), and removes them however it ends.
 * @template T @param {(dirs: { home: string, codexHome: string }) => Promise<T>} fn @returns {Promise<T>}
 */
export async function withProbeHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'postbox-conformance-'));
  try {
    const codexHome = join(home, 'codex');
    await mkdir(codexHome);
    return await fn({ home, codexHome });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** A marker no guide holds by chance. @param {string} what */
export const newMarker = (what) => `postbox-conformance-${what}-${randomBytes(6).toString('hex')}`;

/**
 * The guide Postbox gives a backend, built by Postbox’s own agentGuide, for a persona whose instructions hold the
 * marker: what the check looks for in what the backend saved or sent.
 * @param {string} backend @param {string} marker @param {{ setup?: boolean }} [opts]
 */
export const markedGuide = (backend, marker, { setup = true } = {}) =>
  agentGuide({
    persona: { handle: 'conformance', backend, description: 'Checks guide delivery', instructions: `The conformance marker is ${marker}.` },
    setup,
  });
