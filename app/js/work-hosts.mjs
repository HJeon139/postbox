// Work for an agent on a remote host (#120), for app/js/work.mjs: its files are on the host, which Postbox never reads,
// so its edits show as the files it named, on that host, with no lines, no diff and no Restore, under one line per
// host that says so. A background command there keeps its output file on the host too.

import { h, icon, plural } from './dom.mjs';
import { hostName, workLink } from './work-sections.mjs';

/**
 * One line per host the turns in view ran on: those agents’ files are on the host, so Postbox lists what they edited
 * and records nothing of the files themselves.
 * @param {any[]} turns
 */
export function hostNotes(turns) {
  const by = new Map();
  for (const t of turns) {
    if (!t.host) continue;
    const name = hostName(t);
    (by.get(name) ?? by.set(name, new Set()).get(name)).add(`@${t.handle}`);
  }
  return [...by].map(([name, handles]) =>
    h(
      'p.small.work-host-note',
      `Files on ${name} aren’t recorded: Postbox lists the ones ${[...handles].join(', ')} edited there, with no diff and no Restore.`,
    ),
  );
}

/**
 * Edits on a host, one row per file: how many edits, by whom and in how many turns. A row’s id is its first edit’s,
 * so the pane and the full form name the same item.
 * @param {any[]} edits
 */
export function editRows(edits) {
  const by = new Map();
  for (const e of edits) {
    const key = `${e.host?.id ?? ''}\0${e.path}`;
    const g = by.get(key);
    if (!g) by.set(key, { ...e, tools: e.tools ?? 1, handles: new Set([e.handle]), turns: new Set([e.turnId]) });
    else {
      g.tools += e.tools ?? 1;
      g.handles.add(e.handle);
      g.turns.add(e.turnId);
      g.at = Math.max(g.at ?? 0, e.at ?? 0);
      g.outside ||= e.outside;
    }
  }
  return [...by.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
const notRecorded = (g) => h('span.small.dim', `on ${hostName(g)}, not recorded`);

/**
 * A file an agent on a host edited, in Work’s full form: what the stream named, and why there’s nothing more.
 * @param {(id: string, cls: string, summaryRow: any, body: () => any) => HTMLElement} item  mountWork’s item that opens
 * @param {any} g  a row of editRows @param {{ threadId: string, turnId: string | null }} o
 */
export function editItem(item, g, { threadId, turnId }) {
  const by = [...g.handles].map((x) => `@${x}`).join(', ');
  return item(
    g.id,
    '',
    [
      h('span.mono.work-path', { title: g.path }, g.rel),
      notRecorded(g),
      g.outside ? h('span.work-tag.warn', icon('warn', 'i-sm'), 'Outside the project') : null,
      h('span.small.dim.work-who', by),
    ],
    () => [
      h('p.mono.small.work-full', g.path),
      h(
        'p.small.dim',
        `${plural(g.tools, 'edit')}${turnId ? '' : ` in ${plural(g.turns.size, 'turn')}`} by ${by}, on ${hostName(g)}. The file is on the host, and Postbox didn’t read it, so it has no diff of it and nothing to restore.`,
      ),
      turnId || g.turns.size !== 1 ? null : h('p.small', workLink(threadId, { full: true, turn: g.turnId }, 'That turn')),
    ],
  );
}

/**
 * A file an agent on a host edited, as a row in the pane.
 * @param {(id: string, run: () => void, ...kids: any[]) => HTMLElement} row @param {(to: any) => void} go  the pane’s
 * @param {any} g @param {any} to @param {string} prefix
 */
export const editRow = (row, go, g, to, prefix) =>
  row(
    `${prefix}-${g.id}`,
    () => go(to),
    h('span.mono.wc-name', g.rel.replace(/^.*\//, ''), g.rel.includes('/') ? h('span.dim', ` ${g.rel.replace(/\/[^/]*$/, '')}`) : null),
    notRecorded(g),
  );

/** What a command that ended in the background says of its output, on a host or here. @param {any} c */
export const backgroundNote = (c) =>
  c.host
    ? `It ran in the background on ${hostName(c)}. Its output file stays there, so this is only what it said as it started.`
    : 'It ran in the background; this is its output file.';
