// A saved telemetry report in the Telemetry view (designs/telemetry-persona.md, R18, R19): its bytes, read-only, and
// File issue, which shows the issue’s exact text and hash before anything is sent.

import { api } from './client.mjs';
import { h } from './dom.mjs';
import { openDialog, toast } from './ui.mjs';

const fail = (title) => (e) => toast({ title, text: e.message, level: 'blocking' });

/** A saved report’s bytes, read-only, behind a disclosure: what was saved, as it was saved (R18). */
export function showSaved(convId, id) {
  const pre = h('pre.tv-issue', { tabindex: '0', 'aria-label': `The saved bytes of ${id}` });
  const box = h('details.tv-bytes', h('summary', 'Show the saved report'), pre);
  box.addEventListener('toggle', () => {
    if (box.open && !pre.textContent)
      api(`/api/threads/${convId}/telemetry/reports/${id}/saved`, undefined, 'GET').then((s) => (pre.textContent = s.text), fail('Couldn’t show it'));
  });
  return box;
}

/** File issue: the exact text and its hash first; then gh, or the text copied and GitHub’s new-issue page opened. */
export async function fileIssue(convId, id, f, opener) {
  const at = `/api/threads/${convId}/telemetry/reports/${id}/issues/${encodeURIComponent(f.key)}`;
  const p = await api(at, undefined, 'GET').catch(fail('Couldn’t show the issue'));
  if (!p) return;
  const dlg = openDialog({
    title: 'File this issue?',
    sub: 'In HJeon139/postbox, under your own GitHub account, or copied for you to paste',
    anchor: opener,
    body: [h('pre.tv-issue', { tabindex: '0', 'aria-label': 'The issue’s exact text' }, p.text), h('p.small.mono', `sha256 ${p.hash}`)],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.send',
        {
          type: 'button',
          onclick: () =>
            api(at, { hash: p.hash }).then((r) => {
              dlg.close();
              if (typeof r.copy === 'string') {
                navigator.clipboard?.writeText(r.copy).catch(() => {});
                if (r.open?.startsWith('https://github.com/')) window.open(r.open, '_blank', 'noopener');
                toast({ title: 'Copied the issue’s text', text: 'Paste it into the GitHub page that opened, then submit it there.' });
              } else if (r.filed) toast({ title: `Filed #${r.filed}` });
              else if (r.duplicate && r.closed)
                toast({
                  title: `This may be a regression of #${r.duplicate}`,
                  text: 'That issue is closed. Reopen it, or comment there that it happened again.',
                });
              else if (r.duplicate) toast({ title: `Already filed as #${r.duplicate}` });
            }, fail('Couldn’t file it')),
        },
        'Send',
      ),
    ],
  });
}
