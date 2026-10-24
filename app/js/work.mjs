// The Work view (#132): everything a conversation’s agents changed, ran and published, and what it took, from the
// work ledger (server/ledger.mjs, shared/work.mjs). It covers every session in the conversation, its side and topic
// threads included. Where each change stands (uncommitted, committed, pushed) is asked of git when it opens and
// whenever a turn ends.
//
// It has two forms. In the conversation’s right pane, beside a thread or alone, a compact one (mountWorkPane): what
// needs review, files by where they stand, commands, what was published, spend, and each turn’s line. Full screen, the
// whole of it over the window (mountWork): every file with its diff and Restore, version control, every command with
// its output, and effort by agent.
//
// An agent on a remote host (#120) works on the host’s files, which Postbox never reads: its edits show as the files
// it named, on that host, with no lines, no diff and no Restore, under one line per host that says so.

import { fileEffort, fileState, flagged, formatBytes, formatCost, formatTokens, signed, summarize, turnLine } from '/shared/work.mjs';
import { commandLabel } from '/shared/work-list.mjs';
import { api, client } from './client.mjs';
import { fill, h, icon, plural, timeOf } from './dom.mjs';
import { closeWork, keepFocus, openDialog, openWork, toast } from './ui.mjs';
import { diffView } from './work-diff.mjs';
import { watchGit } from './work-git.mjs';
import { backgroundNote, editItem, editRow, editRows, hostNotes } from './work-hosts.mjs';
import { dur, effortSection, externalSection, publishSection, readsSection, section, signedEl, vcsSection, who, workLink } from './work-sections.mjs';

const S = () => client.state;
const STATE_WORDS = {
  uncommitted: 'Uncommitted',
  committed: 'Committed, not pushed',
  pushed: 'Pushed',
  outside: 'Not in git',
  unchanged: 'Put back',
};
const COMMAND_WORDS = {
  running: 'Running',
  done: 'Exit 0',
  failed: 'Failed',
  denied: 'Refused',
  stopped: 'Stopped',
  background: 'Running in the background',
  unknown: 'Didn’t report how it ended',
};
const GLYPH = { running: 'running', done: 'done', failed: 'failed', denied: 'failed', stopped: 'failed', background: 'running', unknown: 'unknown' };

/** The line of counts for files and lines (“3 files · +40 −12”). */
const counts = (t) => [plural(t.files, 'file'), signedEl(t.added, t.deleted)];

/**
 * The whole Work view: Work’s full form, shown when Work in the pane goes full screen.
 * @param {string} threadId  the conversation
 * @param {{ turnId?: string|null, at?: string|null, gitWatch?: any }} [opts]  turnId: show one turn’s work; at: the item
 *   or section to open and go to; gitWatch: the pane’s git watcher, to share
 */
export function mountWork(threadId, { turnId = null, at = null, gitWatch = null } = {}) {
  const el = h('div.work-view', { tabindex: '-1', dataset: { thread: threadId } });
  let handle = null;
  const opened = new Set(at ? [at] : []); // ids of the items you opened, kept across repaints
  const loaded = new Map(); // what a diff or an output request returned, by item
  const asked = new Set();
  const gitNow = gitWatch ?? watchGit(threadId);
  /** @type {any} */
  let git = gitNow.data;
  let gitError = gitNow.error;
  const unlisten = gitNow.listen(() => {
    git = gitNow.data;
    gitError = gitNow.error;
    paint();
  });
  const load = async (key, url, as = 'json') => {
    if (asked.has(key)) return;
    asked.add(key);
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `The server answered ${r.status}.`);
      loaded.set(key, as === 'json' ? await r.json() : await r.text());
    } catch (e) {
      loaded.set(key, { error: e.message });
    }
    paint();
  };

  const paint = () =>
    keepFocus(el, () => {
      const entries = S().work?.[threadId] ?? [];
      const s = summarize(entries, { git, handle, turnId });
      const turn = turnId ? entries.find((e) => e.kind === 'turn' && e.id === turnId) : null;
      fill(
        el,
        head(entries, turn),
        summary(s),
        filesSection(s, entries),
        vcsSection(s, git),
        publishSection(s, threadId, S().apps),
        externalSection(s),
        commandsSection(s),
        effortSection(s, entries, threadId),
        readsSection(s),
      );
    });

  // ── Parts ─────────────────────────────────────────────────────────────────────────────

  function head(entries, turn) {
    const handles = [...new Set(entries.filter((e) => e.kind === 'turn').map((e) => e.handle))];
    return h(
      'div.ov-head',
      h(
        'div.grow',
        h(
          'p.small.dim',
          'Everything this conversation’s agents changed, ran and published, and what it took. Lines are counted from each file’s diff, not from what an agent said.',
        ),
        turn
          ? h(
              'p.work-turn',
              icon('clock', 'i-sm'),
              `One turn: @${turn.handle} at ${timeOf(turn.startedAt)}${turn.ms ? `, ${dur(turn.ms)}` : ''}. `,
              workLink(threadId, { full: true }, 'Show the whole conversation'),
            )
          : null,
      ),
      !turn && handles.length > 1
        ? h(
            'div.seg',
            { role: 'group', 'aria-label': 'Show the work of' },
            [null, ...handles].map((x) =>
              h(
                'button',
                {
                  type: 'button',
                  id: `work-agent-${x ?? 'all'}`,
                  'aria-pressed': String(handle === x),
                  onclick: () => {
                    handle = x;
                    paint();
                  },
                },
                x ? `@${x}` : 'All agents',
              ),
            ),
          )
        : null,
    );
  }

  function summary(s) {
    const tile = (state, label) =>
      h(
        'div.work-tile',
        { class: `ws-${state}` },
        h('span.label', label),
        h('b', plural(s.byState[state].files, 'file')),
        signedEl(s.byState[state].added, s.byState[state].deleted),
      );
    const e = s.effort;
    return h(
      'section.work-sum',
      { 'aria-label': 'Summary' },
      h(
        'div.work-tiles',
        tile('uncommitted', 'Uncommitted'),
        tile('committed', 'Committed, not pushed'),
        tile('pushed', 'Pushed'),
        s.byState.outside.files ? tile('outside', 'Not in git') : null,
      ),
      h(
        'p.work-effort',
        [
          plural(e.turns, 'turn'),
          e.ms ? dur(e.ms) : null,
          plural(e.toolCalls, 'tool call'),
          e.tokens ? `${formatTokens(e.tokens)} tokens` : null,
          e.priced ? formatCost(e.costUsd) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        e.written ? ` → ${plural(s.total.files, 'file')} ` : null,
        e.written ? signedEl(s.total.added, s.total.deleted) : null,
        e.written && e.written !== e.kept ? h('span.dim', ` (+${e.written.toLocaleString('en-US')} written along the way)`) : null,
        s.commits.length ? ` · ${plural(s.commits.length, 'commit')}` : null,
        s.external.length ? ` · ${s.external.length} outside Postbox` : null,
      ),
      s.idle.turns
        ? h(
            'p.small.dim',
            `${plural(s.idle.turns, 'turn')} left nothing lasting: ${[dur(s.idle.ms), s.idle.priced ? formatCost(s.idle.costUsd) : null].filter(Boolean).join(', ')}. `,
            h(
              'a',
              {
                href: '#work-effort',
                // A link within the view, not an address: the conversation’s address stays as it is.
                onclick: (ev) => {
                  ev.preventDefault();
                  const to = el.querySelector('#work-effort');
                  to?.setAttribute('tabindex', '-1');
                  to?.focus();
                },
              },
              'See which',
            ),
          )
        : null,
      s.flagged
        ? h('p.work-flag-note', icon('warn', 'i-sm'), `${plural(s.flagged, 'change')} to review: outside the project, or to a file git can’t give back.`)
        : null,
      gitLine(),
    );
  }

  function gitLine() {
    if (gitError) return h('p.small.dim', `Git couldn’t say where the changes stand: ${gitError}`);
    if (!git) return h('p.small.dim', 'Asking git where each change stands…');
    if (!git.repos.length) return null;
    return h(
      'p.small.dim',
      'In git: ',
      git.repos.map((r, i) => [
        i ? '; ' : '',
        h('span.mono', r.root.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~')),
        r.branch ? ` on ${r.branch}` : '',
        r.upstream ? `, tracking ${r.upstream}` : r.branch ? ', not tracking a remote branch' : '',
      ]),
      '.',
    );
  }

  /** An item that opens: its summary row, and a body built only when open. */
  function item(id, cls, summaryRow, body) {
    const d = h(
      `details.work-item${cls ? `.${cls}` : ''}`,
      {
        open: opened.has(id),
        ontoggle: () => {
          if (d.open === opened.has(id)) return;
          if (d.open) opened.add(id);
          else opened.delete(id);
          paint();
        },
      },
      h('summary', { id: `wsum-${id}` }, icon('right', 'i-sm'), summaryRow),
      opened.has(id) ? h('div.work-body', body()) : null,
    );
    return d;
  }

  function filesSection(s, entries) {
    const files = [...s.files].sort((a, b) => Number(flagged(b, git)) - Number(flagged(a, git)) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
    const byAgent = s.byAgent.filter((a) => a.files);
    const edits = editRows(s.edits);
    return section(
      'work-files',
      'Files',
      files.length + edits.length,
      hostNotes(s.turns),
      files.length
        ? h(
            'div.work-items',
            files.map((f) => {
              const state = fileState(f, git);
              const key = turnId ? f.changeId : f.id;
              return item(
                key,
                flagged(f, git) ? 'flagged' : '',
                [
                  h('span.status-tag', { class: `ws-${state}` }, STATE_WORDS[state]),
                  h('span.mono.work-path', { title: f.path }, f.rel),
                  f.binary
                    ? h('span.small.dim', `binary · ${formatBytes(f.before?.size ?? 0)} → ${formatBytes(f.after?.size ?? 0)}`)
                    : signedEl(f.added, f.deleted),
                  tags(f),
                  h('span.small.dim.work-who', (turnId ? [f.handle] : f.handles).map((x) => `@${x}`).join(', ')),
                ],
                () => fileBody(f, entries),
              );
            }),
          )
        : edits.length
          ? null
          : h('p.empty-note', 'No files changed yet. A file shows here when an agent’s edit or write changes it.'),
      edits.length
        ? h(
            'div.work-items',
            edits.map((g) => editItem(item, g, { threadId, turnId })),
          )
        : null,
      byAgent.length > 1
        ? h(
            'p.small.dim',
            'By agent: ',
            byAgent.map((a, i) => [i ? ' · ' : '', `@${a.handle} `, ...counts(a)]),
            '. A file’s lines count toward the agent that changed it last.',
          )
        : null,
      h('p.small.dim', 'Changes a command makes (a formatter, a script) aren’t listed yet: Postbox sees the files an agent edits with its file tools.'),
    );
  }

  function tags(f) {
    return [
      f.outside ? h('span.work-tag.warn', icon('warn', 'i-sm'), 'Outside the project') : null,
      f.existed && (f.tracked === false || git?.files?.[f.id]?.state === 'none')
        ? h('span.work-tag.warn', icon('warn', 'i-sm'), 'Git can’t give it back')
        : null,
      !f.existed ? h('span.work-tag', 'New') : null,
      f.after && !f.after.exists ? h('span.work-tag', 'Deleted') : null,
      f.restored ? h('span.work-tag', `Restored at ${timeOf(f.restored.at)}`) : null,
      f.uncounted ? h('span.work-tag', 'Too large to count') : null,
    ];
  }

  function fileBody(f, entries) {
    const changes = entries.filter((e) => e.kind === 'change' && e.fileId === f.id);
    const eff = fileEffort(entries, f.id);
    // A file’s diff changes with what’s there now (a later turn, a restore); one change’s never does.
    const key = turnId ? `diff:${f.changeId}` : `diff:${f.id}:${f.after?.sha256 ?? 'none'}`;
    load(key, `/api/threads/${threadId}/work/files/${f.id}/diff${turnId ? `?change=${encodeURIComponent(f.changeId)}` : ''}`);
    const file = entries.find((e) => e.kind === 'file' && e.id === f.id) ?? f;
    const canRestore = !turnId && !file.restored && (!file.before?.exists || file.before?.sha256) && fileState(file, git) !== 'unchanged';
    return [
      h('p.mono.small.work-full', file.path),
      h(
        'p.small.dim',
        turnId
          ? `This turn’s change: ${signed(f.added, f.deleted)}, in ${plural(f.tools ?? 1, 'edit')}.`
          : [
              `Changed in ${plural(eff.turns, 'turn')} by ${file.handles.map((x) => `@${x}`).join(', ')}`,
              eff.ms ? `, ${dur(eff.ms)}` : '',
              eff.priced ? `, ${formatCost(eff.costUsd)}` : '',
              file.written > file.added
                ? `. +${file.written.toLocaleString('en-US')} lines written along the way, +${file.added.toLocaleString('en-US')} kept.`
                : '.',
            ].join(''),
      ),
      !turnId && changes.length > 1
        ? h(
            'ul.work-changes',
            changes.map((c) =>
              h(
                'li',
                h('span.dim', timeOf(c.at)),
                ` ${who(c)} `,
                c.binary ? 'binary' : signedEl(c.added, c.deleted),
                ' · ',
                workLink(threadId, { full: true, turn: c.turnId }, 'That turn'),
              ),
            ),
          )
        : null,
      diffView(loaded.get(key), f),
      canRestore
        ? h(
            'div.work-actions',
            h(
              'button.btn.sm',
              { type: 'button', id: `restore-${f.id}`, onclick: () => confirmRestore(file) },
              icon('retry', 'i-sm'),
              file.before?.exists ? 'Restore…' : 'Remove…',
            ),
            h('span.small.dim', file.before?.exists ? 'Puts back the copy Postbox kept from before the first change.' : 'An agent created this file.'),
          )
        : null,
    ];
  }

  function confirmRestore(f) {
    const by = f.handles.map((x) => `@${x}`).join(', ');
    const name = f.rel.replace(/^.*\//, '');
    let dlg = null;
    const go = async (button) => {
      button.disabled = true;
      try {
        await api(`/api/threads/${threadId}/work/files/${f.id}/restore`, {});
        dlg?.close();
        toast({ title: f.before?.exists ? `Restored ${name}` : `Removed ${name}` });
      } catch (e) {
        button.disabled = false;
        toast({ title: 'Postbox didn’t change the file', text: e.message, level: 'blocking' });
      }
    };
    dlg = openDialog({
      title: f.before?.exists ? `Restore ${name}?` : `Remove ${name}?`,
      sub: f.path,
      body: h(
        'p',
        f.before?.exists
          ? `Postbox writes back the copy it kept from before ${by} first changed it (${formatBytes(f.before.size ?? 0)}). What’s there now (${signed(f.added, f.deleted)}) is lost unless it’s committed.`
          : `It didn’t exist before ${by} created it, so Postbox deletes it.`,
        ' The agents read that you did on their next turn. If the file changed since their last change, Postbox leaves it alone.',
      ),
      foot: [
        h('button.btn', { type: 'button', onclick: () => dlg?.close() }, 'Cancel'),
        h('button.btn.danger', { type: 'button', onclick: (e) => go(e.currentTarget) }, f.before?.exists ? 'Restore' : 'Remove'),
      ],
    });
  }

  function commandsSection(s) {
    return section(
      'work-commands',
      'Commands',
      s.commands.length,
      s.commands.length
        ? h(
            'div.work-items',
            s.commands.map((c) =>
              item(
                c.id,
                `cmd-${c.state}`,
                [
                  h(`span.g.g-${GLYPH[c.state] ?? 'done'}`, { role: 'img', 'aria-label': COMMAND_WORDS[c.state] ?? c.state }),
                  c.description ? h('span.work-cmd-line', c.description) : h('code.work-cmd-line', `$ ${commandLabel(c, folders(c))}`),
                  h(
                    'span.small.work-exit',
                    { class: c.state === 'failed' || c.state === 'denied' ? 'bad' : '' },
                    c.state === 'failed' && c.exit != null ? `Exit ${c.exit}` : (COMMAND_WORDS[c.state] ?? c.state),
                    c.ms ? ` · ${dur(c.ms)}` : '',
                  ),
                  c.background ? h('span.work-tag', 'Background') : null,
                  h('span.small.dim.work-who', who(c)),
                ],
                () => commandBody(c),
              ),
            ),
          )
        : h('p.empty-note', 'No commands yet.'),
    );
  }

  /** Folders a command’s leading `cd` may name: the project’s and its agent’s, as the turn’s list leaves out. */
  const folders = (c) => [S().projects?.[S().threads[threadId]?.projectId]?.folder, S().personas?.[S().sessions?.[c.sessionId]?.personaId]?.folder];
  function commandBody(c) {
    const key = `out:${c.id}`;
    if (c.state !== 'running' && c.output?.sha256) load(`${key}:${c.output.sha256}`, `/api/threads/${threadId}/work/commands/${c.id}/output`, 'text');
    const out = c.output?.sha256 ? loaded.get(`${key}:${c.output.sha256}`) : '';
    return [
      h('pre.md-code.work-cmd-full', h('code', c.command)),
      h('p.small.dim', `Started ${timeOf(c.startedAt)}${c.who ? ` by the subagent ${c.who}` : ''}.`),
      c.keptRunning
        ? h(
            'p.small.dim',
            c.leftRunning
              ? 'You kept it running when you stopped its agent.'
              : c.state === 'stopped'
                ? `You kept it running when you stopped its agent, then ${c.stoppedBy === 'you' ? 'you' : 'Postbox'} stopped it.`
                : 'You kept it running when you stopped its agent. It has ended; Postbox saw its process go, not its exit.',
          )
        : c.leftRunning
          ? h('p.small.dim', 'It was still running in the background when the turn ended, so Postbox didn’t see it end.')
          : null,
      c.endedInBackground ? h('p.small.dim', backgroundNote(c)) : null,
      c.output?.cut ? h('p.small.dim', 'Earlier output was cut: this is the last 4 MB.') : null,
      c.state === 'running'
        ? h('p.small.dim', 'Its output shows here when it ends.')
        : !c.output?.sha256
          ? h('p.small.dim', 'No output.')
          : out === undefined
            ? h('p.small.dim', 'Loading the output…')
            : typeof out === 'object'
              ? h('p.small.dim', `The output didn’t load: ${out.error}`)
              : h('pre.md-code.cmd-out', { tabindex: '0', 'aria-label': `Output of ${c.command.split('\n')[0]}` }, h('code', out)),
    ];
  }

  // ── Live ──────────────────────────────────────────────────────────────────────────────

  let frame = 0;
  const repaint = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(paint);
  };
  const off = client.on((ch) => {
    if (ch.type === 'load' || ((ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === threadId)) repaint();
  });
  paint();
  return {
    el,
    /** What to put focus on when the view opens: the item or section it was opened at, else the view. */
    target() {
      const sec = at ? el.querySelector(`#${CSS.escape(at)}`) : null;
      sec?.setAttribute('tabindex', '-1');
      return /** @type {HTMLElement} */ ((at && el.querySelector(`#wsum-${CSS.escape(at)}`)) || sec || el);
    },
    destroy() {
      off();
      unlisten();
      if (!gitWatch) gitNow.stop();
      cancelAnimationFrame(frame);
    },
  };
}

// ── The pane ────────────────────────────────────────────────────────────────────────────

/** How many items a list in the pane shows before “All …”, and how many turns before “Show earlier turns”. */
const SHORT = 3;
const TURNS = 8;
const failedCommand = (c) => c.state === 'failed' || c.state === 'denied';

/**
 * Work in the conversation’s right pane, its compact form: what needs review, files by where they stand, commands
 * and how many failed, what was published outside Postbox, spend, and each turn’s line, newest first. Each list is
 * short, and each item opens in the full form. Nothing here moves or pulses: it’s a record, read when you look.
 * Full screen (pane.mjs), the body holds the full form instead (setFull): #138’s view, as it was.
 * @param {string} threadId  the conversation
 */
export function mountWorkPane(threadId) {
  const body = h('div.wp-body', { tabindex: '-1' });
  // The full-screen control, the app frames’ own (#45); pane.mjs gives it its job.
  const fullBtn = h('button.btn.icon.sm', { type: 'button', id: 'work-full', 'aria-label': 'Full screen' }, icon('expand'));
  /** The full form while full screen, and which turn and item it opened on. */
  let full = null;
  const el = h(
    'aside.workpane',
    { id: 'work-pane', 'aria-labelledby': 'wp-title', dataset: { thread: threadId } },
    h(
      'div.wp-head',
      icon('file', 'dim'),
      h('div.grow', h('b', { id: 'wp-title' }, 'Work'), h('div.small.dim', 'What the agents changed, ran and published')),
      fullBtn,
      h('button.btn.icon.sm.ghost', { type: 'button', id: 'work-close', 'aria-label': 'Close Work', onclick: () => closeWork(threadId) }, icon('x')),
    ),
    body,
  );
  let target = null; // the turn the pane was last opened at, from its line in the transcript
  let allTurns = false;
  const openTurns = new Set();
  /** @type {any} */
  let git = null;
  let gitError = '';
  const gitNow = watchGit(threadId);
  gitNow.listen(() => {
    git = gitNow.data;
    gitError = gitNow.error;
    paint();
  });
  /** Opens Work full screen, at an item or section, or on one turn. */
  const go = (to) => openWork(threadId, { full: true, ...to });

  const sec = (id, title, count, ...kids) =>
    h('section.wc-sec', { 'aria-labelledby': `${id}-h` }, h('h2.wc-h', { id: `${id}-h` }, title, count ? h('span.badge', count) : null), ...kids);
  const row = (id, run, ...kids) => h('li', h('button.wc-row', { type: 'button', id, onclick: run }, ...kids));
  /** The first few of a list, then a row that opens the whole of it. */
  const short = (list, make, all, n = SHORT) =>
    h(
      'ul.wc-list',
      list.slice(0, n).map(make),
      list.length > n ? h('li', h('button.wc-row.wc-more', { type: 'button', onclick: all }, `All ${list.length}`, icon('right', 'i-sm'))) : null,
    );
  // A file’s name first, then its folder, so a long path outside the project still shows which file it is.
  const fileRow = (f, to, prefix) =>
    row(
      `${prefix}-${to.at}`,
      () => go(to),
      h('span.mono.wc-name', f.rel.replace(/^.*\//, ''), f.rel.includes('/') ? h('span.dim', ` ${f.rel.replace(/\/[^/]*$/, '')}`) : null),
      f.binary ? h('span.small.dim', 'binary') : signedEl(f.added, f.deleted),
    );
  const commandRow = (c, to, prefix) =>
    row(
      `${prefix}-${c.id}`,
      () => go(to),
      h(`span.g.g-${GLYPH[c.state] ?? 'done'}`, { role: 'img', 'aria-label': COMMAND_WORDS[c.state] ?? c.state }),
      h('code.wc-name', `$ ${c.command.split('\n')[0]}`),
      h(
        'span.small.work-exit',
        { class: failedCommand(c) ? 'bad' : '' },
        c.state === 'failed' && c.exit != null ? `Exit ${c.exit}` : (COMMAND_WORDS[c.state] ?? c.state),
      ),
    );

  function review(s) {
    const list = s.files.filter((f) => flagged(f, git));
    if (!list.length) return null;
    return sec(
      'wc-review',
      [icon('warn', 'i-sm'), 'To review'],
      String(list.length),
      h('p.small.dim', 'Changed outside the project, or a file git can’t give back. Postbox kept a copy from before.'),
      short(
        list,
        (f) => fileRow(f, { at: f.id }, 'wc-review'),
        () => go({ at: 'work-files' }),
      ),
    );
  }

  function files(s) {
    const states = ['uncommitted', 'committed', 'pushed', 'outside'].filter((st) => s.byState[st].files);
    const back = s.byState.unchanged.files;
    const edits = editRows(s.edits);
    return sec(
      'wc-files',
      'Files',
      s.total.files + edits.length ? String(s.total.files + edits.length) : '',
      hostNotes(s.turns),
      // The total, when there’s more than one state to add up.
      states.length > 1 || (back && s.total.files)
        ? h('p.small', plural(s.total.files, 'file'), ' ', signedEl(s.total.added, s.total.deleted), back ? h('span.dim', ` · ${back} put back`) : null)
        : null,
      states.length
        ? states.map((st) =>
            h(
              'div.wc-group',
              h(
                'p.wc-state',
                h('span.status-tag', { class: `ws-${st}` }, STATE_WORDS[st]),
                h('span.small', plural(s.byState[st].files, 'file')),
                signedEl(s.byState[st].added, s.byState[st].deleted),
              ),
              short(
                s.files.filter((f) => fileState(f, git) === st).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
                (f) => fileRow(f, { at: f.id }, 'wc-file'),
                () => go({ at: 'work-files' }),
              ),
            ),
          )
        : edits.length
          ? null
          : h('p.empty-note', back ? 'Every changed file was put back.' : 'No files changed yet.'),
      edits.length
        ? h(
            'div.wc-group',
            short(
              edits,
              (g) => editRow(row, go, g, { at: g.id }, 'wc-edit'),
              () => go({ at: 'work-files' }),
            ),
          )
        : null,
      gitError
        ? h('p.small.dim', `Git couldn’t say where the changes stand: ${gitError}`)
        : !git && s.files.length
          ? h('p.small.dim', 'Asking git where each change stands…')
          : null,
    );
  }

  function commands(s) {
    if (!s.commands.length) return null;
    const failed = s.commands.filter((c) => c.state === 'failed').length;
    const newest = [...s.commands].reverse();
    return sec(
      'wc-commands',
      'Commands',
      String(s.commands.length),
      h('p.small', plural(s.commands.length, 'command'), failed ? h('span.work-exit.bad', ` · ${failed} failed`) : null),
      short(
        [...newest.filter(failedCommand), ...newest.filter((c) => !failedCommand(c))],
        (c) => commandRow(c, { at: c.id }, 'wc-cmd'),
        () => go({ at: 'work-commands' }),
      ),
    );
  }

  function external(s) {
    if (!s.external.length) return null;
    const list = [...s.external].reverse();
    return sec(
      'wc-external',
      'Outside Postbox',
      String(list.length),
      h(
        'ul.wc-list.wc-plain',
        list
          .slice(0, SHORT)
          .map((x) =>
            h(
              'li',
              h('span', x.what),
              x.state === 'failed' || x.state === 'denied' ? [' ', h('span.status-tag.ws-failed', x.state === 'denied' ? 'Refused' : 'Failed')] : null,
              x.urls?.[0]
                ? [
                    ' · ',
                    h(
                      'a',
                      { href: x.urls[0], target: '_blank', rel: 'noopener noreferrer' },
                      x.urls[0].replace(/^https?:\/\/(www\.)?/, ''),
                      ' ',
                      icon('link', 'i-sm'),
                    ),
                  ]
                : null,
            ),
          ),
        list.length > SHORT
          ? h('li', h('button.wc-row.wc-more', { type: 'button', onclick: () => go({ at: 'work-external' }) }, `All ${list.length}`, icon('right', 'i-sm')))
          : null,
      ),
    );
  }

  function spend(s) {
    if (!s.turns.length) return null;
    const e = s.effort;
    const agents = s.byAgent.filter((a) => a.turns);
    return sec(
      'wc-spend',
      'Spend',
      '',
      h(
        'p.small',
        [e.priced ? formatCost(e.costUsd) : null, plural(e.turns, 'turn'), e.ms ? dur(e.ms) : null, e.tokens ? `${formatTokens(e.tokens)} tokens` : null]
          .filter(Boolean)
          .join(' · '),
      ),
      e.priced ? null : h('p.small.dim', 'Spend shows for Claude Code and Agent SDK turns.'),
      agents.length > 1
        ? h(
            'p.small.dim',
            agents.map((a, i) => [i ? ' · ' : '', `@${a.handle} `, e.priced ? formatCost(a.costUsd) : plural(a.turns, 'turn')]),
          )
        : null,
      s.idle.turns
        ? h(
            'p.small.dim',
            `${plural(s.idle.turns, 'turn')} left nothing lasting${[dur(s.idle.ms), s.idle.priced ? formatCost(s.idle.costUsd) : null]
              .filter(Boolean)
              .map((x, i) => `${i ? ', ' : ': '}${x}`)
              .join('')}.`,
          )
        : null,
      h(
        'ul.wc-list',
        row('wc-effort', () => go({ at: 'work-effort' }), h('span.wc-name', 'Effort by agent'), icon('right', 'i-sm')),
      ),
    );
  }

  function turns(entries, list) {
    if (!list.length) return null;
    if (target && list.findIndex((x) => x.t.id === target) >= TURNS) allTurns = true;
    const shown = allTurns ? list : list.slice(0, TURNS);
    return sec(
      'wc-turns',
      'Turns',
      String(list.length),
      h(
        'div.wc-turns',
        shown.map(({ t, line }) => {
          const d = h(
            'details.wc-turn',
            {
              id: `wturn-${t.id}`,
              class: t.id === target ? 'is-target' : '',
              open: openTurns.has(t.id),
              ontoggle: () => {
                if (d.open === openTurns.has(t.id)) return;
                if (d.open) openTurns.add(t.id);
                else openTurns.delete(t.id);
                paint();
              },
            },
            h(
              'summary',
              { id: `wturn-s-${t.id}` },
              icon('right', 'i-sm'),
              h('span.wc-turn-who', h('b', `@${t.handle}`), h('span.small.dim', ` · ${timeOf(t.startedAt)}`)),
              h('span.small.wc-turn-line', line),
            ),
            openTurns.has(t.id) ? turnBody(entries, t) : null,
          );
          return d;
        }),
      ),
      shown.length < list.length
        ? h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => {
                allTurns = true;
                paint();
              },
            },
            `Show ${plural(list.length - shown.length, 'earlier turn')}`,
          )
        : null,
    );
  }

  function turnBody(entries, t) {
    const s = summarize(entries, { git, turnId: t.id });
    return h(
      'div.wc-turn-body',
      s.files.length
        ? short(
            s.files,
            (f) => fileRow(f, { turn: t.id, at: f.changeId }, `wc-t-${t.id}`),
            () => go({ turn: t.id, at: 'work-files' }),
            5,
          )
        : null,
      s.edits.length
        ? short(
            editRows(s.edits),
            (g) => editRow(row, go, g, { turn: t.id, at: g.id }, `wc-t-${t.id}`),
            () => go({ turn: t.id, at: 'work-files' }),
            5,
          )
        : null,
      s.commands.length
        ? short(
            s.commands,
            (c) => commandRow(c, { turn: t.id, at: c.id }, `wc-t-${t.id}`),
            () => go({ turn: t.id, at: 'work-commands' }),
            5,
          )
        : null,
      h('button.btn.sm', { type: 'button', id: `wc-open-${t.id}`, onclick: () => go({ turn: t.id }) }, icon('expand', 'i-sm'), 'Open this turn'),
    );
  }

  const paint = () =>
    keepFocus(body, () => {
      if (full) return;
      const entries = S().work?.[threadId] ?? [];
      const s = summarize(entries, { git });
      const lines = s.turns
        .map((t) => ({ t, line: turnLine(entries, t.id) }))
        .filter((x) => x.line)
        .reverse();
      if (!lines.length && !s.files.length && !s.edits.length && !s.commands.length && !s.external.length)
        return fill(
          body,
          h('p.empty-note', 'Nothing yet. When an agent edits a file, runs a command or publishes something, it shows here, with what it took.'),
        );
      fill(body, review(s), files(s), commands(s), external(s), spend(s), turns(entries, lines));
    });

  let frame = 0;
  const off = client.on((ch) => {
    if (ch.type === 'load' || ((ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === threadId)) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    }
  });
  paint();
  return {
    el,
    /** Opens a turn’s line in the list and scrolls the pane to it; with focus, focus goes to it too. */
    showTurn(turnId, { focus = false } = {}) {
      target = turnId;
      openTurns.add(turnId);
      paint();
      const d = body.querySelector(`#wturn-${CSS.escape(turnId)}`);
      if (!d) return;
      body.scrollTop += d.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
      if (focus) /** @type {HTMLElement} */ (d.querySelector('summary')).focus({ preventScroll: true });
    },
    focus() {
      body.focus();
    },
    fullBtn,
    /**
     * Shows the full form in place of the compact one, on a turn or opened at an item (opts), or the compact one
     * again (null). Returns what focus should go to.
     * @param {{ turn?: string|null, at?: string|null } | null} opts
     */
    setFull(opts) {
      const key = opts ? `${opts.turn ?? ''}|${opts.at ?? ''}` : null;
      if (key === (full?.key ?? null)) return full ? full.view.target() : fullBtn;
      full?.view.destroy();
      full = null;
      if (opts) {
        const view = mountWork(threadId, { turnId: opts.turn ?? null, at: opts.at ?? null, gitWatch: gitNow });
        full = { key, view };
        fill(body, view.el);
        body.scrollTop = 0;
        return view.target();
      }
      paint();
      return fullBtn;
    },
    destroy() {
      off();
      gitNow.stop();
      full?.view.destroy();
      cancelAnimationFrame(frame);
    },
  };
}
