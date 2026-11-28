// The plugin Postbox puts in an Antigravity agent’s folder for a turn: its files, where it goes, and keeping it out of
// git status.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { agentSkillFiles } from './agent-plugin.mjs';
import { HOOK_TIMEOUT_S } from './agy-hook.mjs';
import { agyHooksJson } from './agy-hook-check.mjs';
import { configHash, dropPlugin, notePlugin, PLUGIN_DIR, removePluginFolder, writeRefusal } from './agy-plugin-record.mjs';
import { POSTBOX_SERVER } from './setup.mjs';
import { postboxSkillsOn } from './skill-config.mjs';

/**
 * agy’s limit on the plugin’s rules file, in characters. agyRules (antigravity-cli.mjs) writes within it, and the
 * tests and the conformance probe (#585) hold it to this one number.
 */
export const AGY_RULES_LIMIT = 12_000;

/**
 * The plugin’s files, by path under its folder. Pure, so the tests can check them. `skills`: Postbox’s skills, by path
 * under its skills folder (agentSkillFiles in agent-plugin.mjs), which go in the plugin’s own skills/ folder. Checked
 * with agy 1.5.3: `/skills` listed `postbox:visual-explainer` from there, with the plugin as its source, before the
 * model ran, and `agy plugin validate` counted it.
 * @param {{ mcpUrl: string, rules: string, hookCommand?: string|null, hookTimeout?: number, skills?: Record<string, string> }} opts
 */
export const agyPlugin = ({ mcpUrl, rules, hookCommand = null, hookTimeout = HOOK_TIMEOUT_S, skills = {} }) => ({
  'plugin.json': `${JSON.stringify({ name: POSTBOX_SERVER })}\n`,
  'mcp_config.json': `${JSON.stringify({ mcpServers: { [POSTBOX_SERVER]: { serverUrl: mcpUrl } } }, null, 2)}\n`,
  'rules/AGENTS.md': rules,
  ...(hookCommand ? { 'hooks.json': `${JSON.stringify(agyHooksJson(hookCommand, hookTimeout), null, 2)}\n` } : {}),
  ...Object.fromEntries(Object.entries(skills).map(([path, text]) => [`skills/${path}`, text])),
});
/**
 * Writes the plugin’s files (agyPlugin) into its folder, `dir`. hooks.json is removed first, since a turn before left it
 * read-only, and set read-only again once it’s written. With Postbox’s work root, the folder is noted beside it first, so
 * if Postbox is killed mid-turn, its next start removes the plugin (#314). Says whether it wrote it: it writes nothing,
 * and logs why, where writeRefusal names a reason, and the turn runs without the plugin, as with a hook that didn’t check
 * out.
 * @param {string} dir @param {Record<string, string>} files @param {string | null} [root] @returns {Promise<boolean>}
 */
export async function writeAgyPlugin(dir, files, root = null) {
  const why = await writeRefusal(dir, root);
  if (why) {
    console.error(`Postbox didn’t write its Antigravity plugin at ${dir}: ${why}. The turn runs without Postbox’s tools and rules there.`);
    return false;
  }
  if (root) await notePlugin(root, dir, configHash(files['mcp_config.json'] ?? ''));
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    if (path === 'hooks.json') await rm(file, { force: true }).catch(() => {});
    await writeFile(file, text, path === 'hooks.json' ? { mode: 0o444 } : undefined);
    // The umask masks writeFile’s mode (077 leaves 0o400), so hooks.json is set to 0o444 after it’s written (#730).
    if (path === 'hooks.json') await makeReadOnly(file);
  }
  return true;
}

/**
 * Removes the plugin a turn wrote, and the folders above it, only if the plugin was all they held. With Postbox’s work
 * root, the note of it beside that is dropped too (#314).
 * @param {string} plugin @param {string | null} [root]
 */
export async function removeAgyPlugin(plugin, root = null) {
  // Dropped only once it’s gone: one the turn couldn’t remove, or can’t even look at, stays noted for the next start.
  const gone = (await removePluginFolder(plugin).catch(() => false)) === true;
  if (root && gone) await dropPlugin(root, plugin).catch(() => {});
}

/** The files of Postbox’s skills a persona keeps on (#207), for the plugin’s skills/ folder. */
export const agySkillFiles = (persona) => agentSkillFiles(postboxSkillsOn(persona));

// Where the plugin goes in the agent’s folder: defined beside the record of where it was written, and kept here for
// those that import it from this module.
export { PLUGIN_DIR };

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

/**
 * Sets a file to mode 0o444, read-only for everyone, whatever the umask left it at (#730), and says whether it did. A
 * filesystem that refuses chmod (some FUSE, SMB or FAT mounts) leaves the file as written, already read-only to its
 * owner, so the turn goes on rather than failing to start.
 * @param {string} file @param {(path: string, mode: number) => Promise<void>} [setMode]  chmod; a test gives its own
 */
export async function makeReadOnly(file, setMode = chmod) {
  try {
    await setMode(file, 0o444);
    return true;
  } catch {
    return false;
  }
}
