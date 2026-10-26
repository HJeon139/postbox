// Manage Postbox settings in Antigravity CLI configuration (~/.gemini/antigravity-cli/settings.json).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { POSTBOX_SERVER } from './setup.mjs';

export const agySettingsFile = (home = homedir()) => join(home, '.gemini', 'antigravity-cli', 'settings.json');

/** Postbox’s server, as agy names it: the plugin’s name, then the server’s. */
export const AGY_SERVER = `${POSTBOX_SERVER}_${POSTBOX_SERVER}`;
/** The one rule Postbox adds to your agy settings, so its own tools aren’t refused headless. */
export const ALLOW_POSTBOX = `mcp(${AGY_SERVER}/*)`;

/**
 * Adds ALLOW_POSTBOX to `permissions.allow` in your agy settings, keeping everything else. A file agy itself
 * couldn’t read is left alone (agy 1.4.5’s changelog: it no longer overwrites one), and Postbox’s tools are then
 * refused, which the turn shows.
 * @returns {Promise<'added'|'present'|'unreadable'>}
 */
export async function allowPostbox(file = agySettingsFile()) {
  /** @type {any} */
  let settings = {};
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') return 'unreadable';
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'unreadable';
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(ALLOW_POSTBOX)) return 'present';
  const next = { ...settings, permissions: { ...permissions, allow: [...allow, ALLOW_POSTBOX] } };
  await mkdir(dirname(file), { recursive: true });
  // Written beside it and renamed, so agy never reads half a file.
  const tmp = `${file}.postbox-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return 'added';
}
