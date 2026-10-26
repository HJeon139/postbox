// Where each of a conversation’s changed files stands in git, for Work (app/js/work.mjs): asked of the server when
// Work opens and again as turns end, commits and pushes land and files are restored, and shared by the pane’s two
// forms.

import { client } from './client.mjs';

/**
 * Where each change stands, asked of git when Work opens and again once a turn ends, a commit or push lands, or a
 * file is restored. Calls back everyone listening on every answer; the pane’s two forms share one.
 * @param {string} threadId
 */
export function watchGit(threadId) {
  const g = { data: /** @type {any} */ (null), error: '' };
  const listeners = new Set();
  let timer = 0;
  let stopped = false;
  const load = async () => {
    try {
      const r = await fetch(`/api/threads/${threadId}/work/git`, { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? `The server answered ${r.status}.`);
      g.data = data;
      g.error = '';
    } catch (e) {
      g.error = e.message;
    }
    if (!stopped) for (const fn of [...listeners]) fn();
  };
  const off = client.on((ch) => {
    if ((ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === threadId) {
      // A turn that ended, a commit or a restore changes where files stand: ask git again, once things settle.
      const done = ch.type === 'work.patch' ? ch.data.patch.status || ch.data.patch.restored : ['commit', 'push', 'restore'].includes(ch.data.entry.kind);
      if (done) {
        clearTimeout(timer);
        timer = setTimeout(load, 800);
      }
    }
  });
  load();
  return Object.assign(g, {
    /** @param {() => void} fn  @returns {() => void} */
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      off();
      clearTimeout(timer);
    },
  });
}
