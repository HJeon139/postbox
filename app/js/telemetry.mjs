// Telemetry on the page (designs/telemetry-persona.md, R1, R5, R18, R19): Record this room and the rest in the
// conversation’s ⋯ menu, the recording’s state in the header, and the Telemetry view in the right pane, like Work. The
// view asks whether to include the history, makes the report, and shows its summary and every line of the exact bytes
// Postbox would save, each with Leave out, and their hash; Save writes them. Saved reports open there again, to File
// issue, which shows the issue’s exact text and hash before anything is sent, or to Delete. Nothing appears in the room.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { fileIssue, showSaved } from './telemetry-issue.mjs';
import { navigate, openDialog, paneHref, route, setPaneFull, toast } from './ui.mjs';

const S = () => client.state;
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
            run: () => openTelemetry(t.id),
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

/** Opens the Telemetry view in Work’s place, beside the thread open there; Work comes back when it closes (R18). */
function openTelemetry(convId) {
  const r = route();
  const here = r.view === 'thread' && r.threadId === convId;
  navigate(paneHref(convId, { side: here ? r.sideId : null, work: here && r.work, telemetry: true }), { replace: here });
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
  // The top bar is rebuilt often: a badge that’s left it stops listening, so listeners don’t pile up.
  let shown = false;
  const off = client.on((ch) => {
    if (badge.isConnected) shown = true;
    else if (shown) return off();
    if (ch.type === 'thread' && ch.data.id === t?.id) paint();
  });
  return t ? badge : null;
}

/**
 * The Telemetry view, in Work’s slot of the right pane (pane.mjs): its head names it, takes it full screen, and closes
 * it, which brings Work back if Work was open. Closing keeps an unsaved draft; Discard deletes it (R18).
 * @param {string} convId
 */
export function mountTelemetryView(convId) {
  const body = h('div.sp-body.tv-body');
  const close = h(
    'button.btn.icon.sm',
    {
      type: 'button',
      'aria-label': 'Close Telemetry',
      onclick: () => {
        const r = route();
        navigate(paneHref(convId, { side: r.sideId, work: r.work }), { replace: true });
      },
    },
    icon('x'),
  );
  const fullBtn = h('button.btn.icon.sm', { type: 'button', id: 'telemetry-full', 'aria-label': 'Full screen' }, icon('expand'));
  const el = h(
    'aside.sidepanel.telemetry-view',
    { 'aria-labelledby': 'tv-title' },
    h('div.sp-head', h('h2.sp-title', { id: 'tv-title' }, 'Telemetry'), fullBtn, close),
    body,
  );
  const load = () =>
    api(`/api/threads/${convId}/telemetry`, undefined, 'GET')
      .then(async (o) => {
        const draft = o.draft ? await api(`/api/threads/${convId}/telemetry/reports/${o.draft}`, undefined, 'GET') : null;
        // Focus stays on the control you used, found again by its id after the repaint, and the history box keeps its tick.
        const had = body.contains(document.activeElement) ? document.activeElement?.id : null;
        body.replaceChildren(...(draft ? draftView(convId, draft, load) : askView(convId, o, load, ask)), ...savedView(convId, o.saved, load));
        const back = had ? document.getElementById(had) : null;
        (back && body.contains(back) ? back : had ? body.querySelector('button, input') : null)?.focus();
      })
      .catch(fail('Couldn’t open Telemetry'));
  const ask = { history: false };
  load();
  // A message in the room changes nothing here: only a change to the recording repaints.
  let rec = JSON.stringify(S().threads[convId]?.recording ?? null);
  const off = client.on((ch) => {
    if (ch.type !== 'thread' || ch.data.id !== convId || JSON.stringify(ch.data.recording ?? null) === rec) return;
    rec = JSON.stringify(ch.data.recording ?? null);
    load();
  });
  const setFull = (on) => {
    el.classList.toggle('tv-full', !!on);
    return fullBtn;
  };
  return { el, fullBtn, setFull, destroy: off, focus: () => close.focus(), exitFull: () => setPaneFull(null) };
}

/** Before a report: whether to include the history (R2), and Make report. */
function askView(convId, o, load, ask) {
  const history = h('input', { type: 'checkbox', id: 'tv-history', checked: ask.history, onchange: () => (ask.history = history.checked) });
  const make = h(
    'button.btn.send',
    {
      type: 'button',
      id: 'tv-make',
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
              id: `tv-out-${l.n}`,
              // One name; pressed says whether it’s left out.
              'aria-pressed': String(l.out),
              'aria-label': `Leave out line ${l.n}`,
              onclick: () => api(`${at}/leave-out`, { line: l.n, out: !l.out }).then(load, fail('Couldn’t change it')),
            },
            'Leave out',
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
    h(
      'div.tv-actions',
      h(
        'button.btn.send',
        { type: 'button', id: 'tv-save', onclick: () => api(`${at}/save`, { hash: d.hash }).then(load, fail('Couldn’t save it')) },
        'Save report',
      ),
      h('button.btn', { type: 'button', id: 'tv-discard', onclick: () => api(`${at}/discard`, {}).then(load, fail('Couldn’t discard it')) }, 'Discard'),
    ),
    h('p.small', 'Closing the view keeps this report as it is until you save or discard it.'),
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
        r.broken ? h('p.small', r.broken) : showSaved(convId, r.id),
        h(
          'ul.tv-findings',
          r.findings.map((f) =>
            h('li', h('span', f.title), h('button.btn.sm', { type: 'button', onclick: (e) => fileIssue(convId, r.id, f, e.currentTarget) }, 'File issue')),
          ),
        ),
        h(
          'button.btn.sm.danger',
          {
            type: 'button',
            id: `tv-delete-${r.id}`,
            onclick: () => api(`/api/threads/${convId}/telemetry/reports/${r.id}`, null, 'DELETE').then(load, fail('Couldn’t delete it')),
          },
          'Delete report',
        ),
      ),
    ),
  ];
}
