// The plugin Postbox puts in an Antigravity agent’s folder for a turn: its files, where it goes, and keeping it out of
// git status.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { agyHooksJson, HOOK_TIMEOUT_S } from './agy-hook.mjs';
import { POSTBOX_SERVER } from './setup.mjs';

/**
 * The plugin’s files, by path under its folder. Pure, so the tests can check them.
 * @param {{ mcpUrl: string, rules: string, hookCommand?: string|null, hookTimeout?: number }} opts
 */
export const agyPlugin = ({ mcpUrl, rules, hookCommand = null, hookTimeout = HOOK_TIMEOUT_S }) => ({
  'plugin.json': `${JSON.stringify({ name: POSTBOX_SERVER })}\n`,
  'mcp_config.json': `${JSON.stringify({ mcpServers: { [POSTBOX_SERVER]: { serverUrl: mcpUrl } } }, null, 2)}\n`,
  'rules/AGENTS.md': rules,
  ...(hookCommand ? { 'hooks.json': `${JSON.stringify(agyHooksJson(hookCommand, hookTimeout), null, 2)}\n` } : {}),
});
/** Where the plugin goes in the agent’s folder. */
export const PLUGIN_DIR = join('.agents', 'plugins', POSTBOX_SERVER);

/**
 * The repository’s exclude file for a folder, or null outside a git repository. Read from the files, without git:
 * the nearest .git above the folder is the repository’s folder, or, in a worktree or a submodule, a file that names
 * it (“gitdir: …”). A worktree shares its main repository’s exclude file, which its commondir names.
 */
export async function excludeFile(cwd) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    const pointer = await readFile(git, 'utf8').catch((e) => (e?.code === 'EISDIR' ? '' : null));
    if (pointer === '') return join(git, 'info', 'exclude');
    const gitdir = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    if (gitdir) {
      const own = resolve(dir, gitdir);
      const common = (await readFile(join(own, 'commondir'), 'utf8').catch(() => '')).trim();
      return join(common ? resolve(own, common) : own, 'info', 'exclude');
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Adds the plugin folder to the repository’s exclude file, once, so it never shows in git status. */
export async function excludePlugin(cwd) {
  const file = await excludeFile(cwd);
  if (!file) return false;
  const text = await readFile(file, 'utf8').catch(() => '');
  const line = `${PLUGIN_DIR.split('\\').join('/')}/`;
  if (text.split('\n').includes(line)) return true;
  await mkdir(dirname(file), { recursive: true });
  // Written beside it and renamed, so git never reads half a file.
  const tmp = `${file}.postbox-${process.pid}`;
  await writeFile(tmp, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Postbox’s plugin for an Antigravity turn, there only while it runs\n${line}\n`);
  await rename(tmp, file);
  return true;
}
