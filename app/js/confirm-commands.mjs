// The commands a confirm runs when the person confirms (#852 slice 1a). They run with no second card, so each is
// drawn whole, as plain text in a box of its own that wraps: never through Markdown, never folded, never cut off.
// A command that posts a file with --body-file shows that file under it, as Postbox read it, the same way.

import { formatBytes } from '/shared/work.mjs';
import { h } from './dom.mjs';

/**
 * A body file the server read for a confirm (server/confirm-body.mjs): its first 40 lines, and how many it has.
 * @typedef {{ command: number, path: string, sha256: string, size: number, text: string, lines: number }} BodyFile
 */

/**
 * “Posts this file”: the file’s path, size and SHA-256, and its text as one text node, never through Markdown.
 * @param {BodyFile} file
 */
function bodySection(file) {
  const shown = file.text.split('\n').length;
  return h(
    'div.confirm-body-file',
    { role: 'group', 'aria-label': 'Posts this file' },
    h('div.confirm-cmds-head', 'Posts this file'),
    h('div.small.dim.confirm-body-meta', `${file.path} · ${formatBytes(file.size)} · SHA-256 ${file.sha256.slice(0, 12)}`),
    h('pre.confirm-body', h('code', file.text)),
    file.lines > shown ? h('div.small.dim', `First ${shown} of ${file.lines} lines.`) : null,
  );
}

/**
 * The “Runs when you confirm” section under a confirm’s statement, or null when it names no commands.
 * @param {string[] | undefined} commands  the confirm’s commands, as the catalog passed them
 * @param {BodyFile[] | undefined} [bodyFiles]  the files those commands post, as the item keeps them
 */
export function commandsSection(commands, bodyFiles = []) {
  if (!commands?.length) return null;
  return h(
    'div.confirm-cmds',
    { role: 'group', 'aria-label': 'Runs when you confirm' },
    h('div.confirm-cmds-head', 'Runs when you confirm'),
    commands.map((text, i) => [h('pre.confirm-cmd', h('code', text)), bodyFiles.filter((f) => f.command === i).map(bodySection)]),
  );
}
