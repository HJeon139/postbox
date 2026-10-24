// Telemetry on the page (designs/telemetry-persona.md, R1, R5, R18, R19): Record this room and the rest in the
// conversation’s ⋯ menu, the recording’s state in the header, and the Telemetry view in the right pane, like Work. The
// view asks whether to include the history, makes the report, and shows its summary and every line of the exact bytes
// Postbox would save, each with Leave out, and their hash; Save writes them. Saved reports open there again, to File
// issue, which shows the issue’s exact text and hash before anything is sent, or to Delete. Nothing appears in the room.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { navigate, openDialog, paneHref, route, toast } from './ui.mjs';

const S = () => client.state;
/** The right pane’s slot for the Telemetry view: the side id it opens under (pane.mjs). */
export const TELEMETRY = 'telemetry';
const fail = (title) => (e) => toast({ title, text: e.message, level: 'blocking' });
const time = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The ⋯ menu’s telemetry items for a conversation (R1). */
export function telemetryItems(t) {
  if (t.kind === 'side' || t.kind === 'topic') return [];
  const rec = t.recording;
  return [
    rec?.on
      ? {
          label: 'Stop recording',
          icon: 'clock',
          desc: 'What’s recorded stays until you delete it',
          run: () => api(`/api/threads/${t.id}/telemetry/stop`, {}).catch(fail('Couldn’t stop recording')),
        }
      : {
          label: 'Record this room',
          icon: 'clock',
          desc: 'For a report you review. Nothing in the room changes',
          run: () => api(`/api/threads/${t.id}/telemetry/record`, {}).catch(fail('Couldn’t start recording')),
        },
    ...(rec
      ? [
          {
            label: 'Telemetry report…',
            icon: 'list',
            desc: 'Opens the Telemetry view beside the conversation',
            run: () => navigate(`#/t/${t.id}/side/${TELEMETRY}`),
          },
          { label: 'Delete recordings…', icon: 'trash', danger: true, desc: 'At once. Saved reports stay', run: () => confirmDeleteRecordings(t) },
        ]
      : []),
  ];
}

function confirmDeleteRecordings(t) {
  const dlg = openDialog({
    title: `Delete the recordings of “${t.title}”?`,
    role: 'alertdialog',
    body: [h('p', 'This deletes its recorded streams and events now. Reports you saved stay until you delete them.')],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        { type: 'button', onclick: () => api(`/api/threads/${t.id}/telemetry/delete`, {}).then(() => dlg.close(), fail('Couldn’t delete the recordings')) },
        'Delete recordings',
      ),
    ],
  });
}

/** The header’s word for a recording conversation (R5): “Recording since 14:02”, kept up to date. */
export function recordingBadge(t) {
  const badge = h('span.rec-badge', { id: 'recording-badge', role: 'status' });
  const paint = () => {
    const rec = S().threads[t?.id]?.recording;
    badge.hidden = !rec?.on;
    badge.textContent = rec?.on ? `Recording since ${time(rec.startedAt ?? rec.since)}` : '';
  };
  paint();
  client.on((ch) => (ch.type === 'thread' && ch.data.id === t?.id && badge.isConnected ? paint() : null));
  return t ? badge : null;
}

/**
 * The Telemetry view, in the right pane’s thread slot (pane.mjs): its head names it and closes it, like a thread’s.
 * @param {string} convId
 */
export function mountTelemetryView(convId) {
  const body = h('div.sp-body.tv-body');
  const close = h(
    'button.btn.icon.sm',
    { type: 'button', 'aria-label': 'Close Telemetry', onclick: () => navigate(paneHref(convId, { work: route().work })) },
    icon('x'),
  );
  const el = h(
    'aside.sidepanel.telemetry-view',
    { 'aria-labelledby': 'sp-title' },
    h('div.sp-head', h('h2.sp-title', { id: 'sp-title' }, 'Telemetry'), close),
    body,
  );
  const load = () =>
    api(`/api/threads/${convId}/telemetry`, undefined, 'GET')
      .then(async (o) => {
        const draft = o.draft ? await api(`/api/threads/${convId}/telemetry/reports/${o.draft}`, undefined, 'GET') : null;
        body.replaceChildren(...(draft ? draftView(convId, draft, load) : askView(convId, o, load)), ...savedView(convId, o.saved, load));
      })
      .catch(fail('Couldn’t open Telemetry'));
  load();
  const off = client.on((ch) => (ch.type === 'thread' && ch.data.id === convId && !body.querySelector('.tv-lines') ? load() : null));
  return { el, destroy: off, focus: () => close.focus() };
}

/** Before a report: whether to include the history (R2), and Make report. */
function askView(convId, o, load) {
  const history = h('input', { type: 'checkbox', id: 'tv-history' });
  const make = h(
    'button.btn.send',
    {
      type: 'button',
      disabled: !o.recording,
      onclick: () => {
        make.disabled = true;
        make.textContent = 'Making the report…';
        api(`/api/threads/${convId}/telemetry/reports`, { history: history.checked }).then(load, (e) => {
          make.disabled = false;
          make.textContent = 'Make report';
          fail('Couldn’t make the report')(e);
        });
      },
    },
    'Make report',
  );
  return [
    h(
      'p.small',
      o.recording
        ? o.recording.on
          ? `Recording since ${time(o.recording.startedAt ?? o.recording.since)}.`
          : 'Recording stopped.'
        : 'Not recorded. Choose Record this room in the ⋯ menu.',
    ),
    h('label.check-row', history, ' Include the room’s history from before recording started'),
    make,
  ];
}

/** A report before it’s saved (R18): the summary, every line of the bytes with Leave out, their hash, and Save. */
function draftView(convId, d, load) {
  const at = `/api/threads/${convId}/telemetry/reports/${d.id}`;
  const lines = h(
    'ol.tv-lines',
    { 'aria-label': 'The bytes Postbox would save' },
    d.lines.map((l) =>
      h(
        'li',
        { class: l.out ? 'out' : '' },
        h('span.tv-n', { 'aria-hidden': 'true' }, String(l.n)),
        h('code.tv-text', l.line),
        l.toggle &&
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              'aria-pressed': String(l.out),
              'aria-label': `${l.out ? 'Put back' : 'Leave out'} line ${l.n}`,
              onclick: () => api(`${at}/leave-out`, { line: l.n, out: !l.out }).then(load, fail('Couldn’t change it')),
            },
            l.out ? 'Put back' : 'Leave out',
          ),
      ),
    ),
  );
  return [
    h('h3.tv-h', 'Report'),
    h(
      'table.tv-summary',
      h(
        'tbody',
        d.summary.map(([k, v]) => h('tr', h('th', { scope: 'row' }, k), h('td', String(v)))),
      ),
    ),
    h('p.small', 'These are the exact bytes Postbox would save, and nothing leaves this computer when you save them. Leave out any line you don’t want in it.'),
    lines,
    h('p.small.mono.tv-hash', `${d.bytes.length.toLocaleString('en-US')} bytes · sha256 ${d.hash}`),
    h('button.btn.send', { type: 'button', onclick: () => api(`${at}/save`, { hash: d.hash }).then(load, fail('Couldn’t save it')) }, 'Save report'),
  ];
}

/** Saved reports: each finding’s File issue, and Delete (R19). */
function savedView(convId, saved, load) {
  if (!saved.length) return [];
  return [
    h('h3.tv-h', 'Saved reports'),
    ...saved.map((r) =>
      h(
        'section.tv-saved',
        { 'aria-label': `Saved report ${r.id}` },
        h('p.small.mono', `${r.id} · sha256 ${r.hash.slice(0, 12)}`),
        h(
          'ul.tv-findings',
          r.findings.map((f) =>
            h('li', h('span', f.title), h('button.btn.sm', { type: 'button', onclick: (e) => fileIssue(convId, r.id, f, e.currentTarget) }, 'File issue')),
          ),
        ),
        h(
          'button.btn.sm.danger',
          { type: 'button', onclick: () => api(`/api/threads/${convId}/telemetry/reports/${r.id}`, null, 'DELETE').then(load, fail('Couldn’t delete it')) },
          'Delete report',
        ),
      ),
    ),
  ];
}

/** File issue: the exact text and its hash first; then gh, or the text copied and GitHub’s new-issue page opened. */
async function fileIssue(convId, id, f, opener) {
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
              else if (r.duplicate) toast({ title: `Already filed as #${r.duplicate}` });
            }, fail('Couldn’t file it')),
        },
        'Send',
      ),
    ],
  });
}
