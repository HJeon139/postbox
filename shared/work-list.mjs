// A turn’s list (#195): what one turn changed, showed, committed, wrote outside Postbox and ran, then what it read,
// one row each, from the work ledger’s entries. The transcript draws it under the turn’s last reply (app/js/work-list.mjs),
// and each row opens Work at its entry, so the list and Work can’t disagree.

import { readsLine, summarize } from './work.mjs';

/** Whether an app is retired (#193): state.apps[id].retired is { by, reason, replacedBy, at } while it is. */
export const retiredApp = (app) => Boolean(app?.retired);

/** A command as a row shows it: the agent’s description, else the command without a leading `cd <folder> &&`. */
export function commandLabel(c, folders = []) {
  if (c.description) return c.description;
  const line = String(c.command ?? '').split('\n')[0];
  const m = /^cd\s+("([^"]*)"|'([^']*)'|(\S+))\s*&&\s*/.exec(line);
  const to = m ? (m[2] ?? m[3] ?? m[4]).replace(/\/$/, '') : null;
  return m && folders.some((f) => f && f.replace(/\/$/, '') === to) ? line.slice(m[0].length) : line;
}

/**
 * The rows, in order: files, apps and blocks, commits and pushes, writes outside Postbox, commands, then one row for
 * the reads. Each is { kind, at, label, … }, where at is the Work entry (or section) it opens.
 * @param {any[]} entries  the conversation’s ledger @param {string} turnId
 * @param {{ folders?: (string|null)[] }} [opts]  folders a command’s leading `cd` may name and leave out
 */
export function turnRows(entries, turnId, { folders = [] } = {}) {
  const s = summarize(entries, { turnId });
  const rows = [];
  for (const f of s.files)
    rows.push({
      kind: 'file',
      at: f.id,
      label: f.rel,
      added: f.added ?? 0,
      deleted: f.deleted ?? 0,
      binary: Boolean(f.binary),
      tag: !f.before?.exists && f.after?.exists ? 'New' : f.before?.exists && !f.after?.exists ? 'Deleted' : '',
      outside: Boolean(f.outside),
    });
  for (const p of s.publishes)
    rows.push({ kind: 'publish', at: p.id, label: p.title, detail: p.what === 'app' ? `v${p.version ?? 1}` : p.type, what: p.what, blockId: p.blockId });
  for (const c of s.commits)
    rows.push({
      kind: 'commit',
      at: c.id,
      label: c.message || '(no message)',
      detail: String(c.sha ?? '').slice(0, 7),
      left: Boolean(c.left),
      overlap: Boolean(c.overlap),
    });
  for (const p of s.pushes) rows.push({ kind: 'push', at: p.id, label: `Pushed ${p.branch || 'a branch'}`, detail: p.remote ?? '' });
  for (const x of s.external) rows.push({ kind: 'external', at: x.id, label: x.what, url: x.urls?.[0] ?? null, state: x.state });
  for (const c of s.commands) rows.push({ kind: 'command', at: c.id, label: commandLabel(c, folders), state: c.state, exit: c.exit ?? null });
  if (s.reads.length) rows.push({ kind: 'reads', at: 'work-reads', label: readsLine(s.reads), count: s.reads.length });
  return rows;
}
