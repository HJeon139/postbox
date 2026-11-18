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
import { fileGroups } from '/shared/work-groups.mjs';
import { api, client } from './client.mjs';
import { fill, h, icon, plural, timeOf } from './dom.mjs';
import { heldFrame } from './held-frame.mjs';
import { closeWork, keepFocus, openDialog, openWork, toast } from './ui.mjs';
import { assetsSection } from './work-assets.mjs';
import { COMMAND_WORDS, commandsSection, GLYPH } from './work-commands.mjs';
import { diffView } from './work-diff.mjs';
import { watchGit } from './work-git.mjs';
import { editItem, editRow, editRows, hostNotes } from './work-hosts.mjs';
import { external, row, sec, short, spend } from './work-pane-parts.mjs';
import { chatList, relevantSection, shownIds } from './work-relevant.mjs';
import { dur, effortSection, externalSection, publishSection, readsSection, section, signedEl, vcsSection, who, workLink } from './work-sections.mjs';
import { shownSection } from './work-shown.mjs';
import { paneViewer } from './work-viewer.mjs';
import { windows } from './work-window.mjs';

const S = () => client.state;
const STATE_WORDS = {
  uncommitted: 'Uncommitted',
  committed: 'Committed, not pushed',
  pushed: 'Pushed',
  outside: 'Not in git',
  unchanged: 'Put back',
};

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
  const win = windows(() => paint(), at); // the long lists’ windows (#618)
  const asked = new Set();
  const gitNow = gitWatch ?? watchGit(threadId);
  /** @type {any} */
  let git = gitNow.data;
  let gitError = gitNow.error;
  const unlisten = gitNow.listen(() => {
    git = gitNow.data;
    gitError = gitNow.error;
    live.held();
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
    live.held();
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
        commandsSection(s, { threadId, item, load, loaded, win }),
        effortSection(s, entries, threadId, win),
        readsSection(s, win),
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
              `One turn: ${turn.handle} at ${timeOf(turn.startedAt)}${turn.ms ? `, ${dur(turn.ms)}` : ''}. `,
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
                    win.reset(); // another agent’s lists, from their newest (#618)
                    paint();
                  },
                },
                x ? x : 'All agents',
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
    // What it was built as: a copy rebuilt by a held refill fires its own toggle, which must not undo the press (#1010).
    const built = opened.has(id);
    const d = h(
      `details.work-item${cls ? `.${cls}` : ''}`,
      {
        open: built,
        ontoggle: () => {
          if (d.open === built) return;
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
    const sorted = [...s.files].sort((a, b) => Number(flagged(b, git)) - Number(flagged(a, git)) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
    const keyOf = (f) => (turnId ? f.changeId : f.id);
    const opts = { idOf: keyOf, elId: (f) => `wsum-${keyOf(f)}`, newest: /** @type {const} */ ('start'), before: 'later file', after: 'earlier file' };
    const { items: files, above, below } = win('files', sorted, opts);
    const byAgent = s.byAgent.filter((a) => a.files);
    const edits = editRows(s.edits);
    return section(
      'work-files',
      'Files',
      sorted.length + edits.length,
      hostNotes(s.turns),
      above,
      files.length
        ? h(
            'div.work-items',
            files.map((f) => {
              const state = fileState(f, git);
              return item(
                keyOf(f),
                flagged(f, git) ? 'flagged' : '',
                [
                  h('span.status-tag', { class: `ws-${state}` }, STATE_WORDS[state]),
                  h('span.mono.work-path', { title: f.path }, f.rel),
                  f.binary
                    ? h('span.small.dim', `binary · ${formatBytes(f.before?.size ?? 0)} → ${formatBytes(f.after?.size ?? 0)}`)
                    : signedEl(f.added, f.deleted),
                  tags(f),
                  h('span.small.dim.work-who', (turnId ? [f.handle] : f.handles).join(', ')),
                ],
                () => fileBody(f, entries),
              );
            }),
          )
        : edits.length
          ? null
          : h('p.empty-note', 'No files changed yet. A file shows here when an agent’s edit or write changes it.'),
      below,
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
            byAgent.map((a, i) => [i ? ' · ' : '', `${a.handle} `, ...counts(a)]),
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
    void load(key, `/api/threads/${threadId}/work/files/${f.id}/diff${turnId ? `?change=${encodeURIComponent(f.changeId)}` : ''}`);
    const file = entries.find((e) => e.kind === 'file' && e.id === f.id) ?? f;
    const canRestore = !turnId && !file.restored && (!file.before?.exists || file.before?.sha256) && fileState(file, git) !== 'unchanged';
    return [
      h('p.mono.small.work-full', file.path),
      h(
        'p.small.dim',
        turnId
          ? `This turn’s change: ${signed(f.added, f.deleted)}, in ${plural(f.tools ?? 1, 'edit')}.`
          : [
              `Changed in ${plural(eff.turns, 'turn')} by ${file.handles.join(', ')}`,
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
    const by = f.handles.join(', ');
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

  // ── Live ──────────────────────────────────────────────────────────────────────────────

  // What the server sends waits while a press is down, so its click lands on the button it started on (#1010).
  const live = heldFrame(el, paint);
  const off = client.on((ch) => {
    if (ch.type === 'load' || ((ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === threadId)) live.soon();
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
      live.cancel();
    },
  };
}

// ── The pane ────────────────────────────────────────────────────────────────────────────

/** How many turns the pane shows before “Show earlier turns”. */
const TURNS = 8;
const failedCommand = (c) => c.state === 'failed' || c.state === 'denied';

/**
 * Work in the conversation’s right pane, its compact form, in the order people open it for (#1446): what the chat is
 * about now (In this chat), files by where they stand with what needs review first, the room’s assets, then under
 * More the commands (in view while one in the latest turn failed), what was published outside Postbox, spend, and
 * each turn’s line, newest first. Each list is short; a file or an asset opens in the pane’s viewer, and anything
 * else in the full form. Nothing here moves or pulses: it’s a record, read when you look.
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
  let allAssets = false;
  let allNow = false;
  let allShown = false;
  let moreOpen = false;
  const openTurns = new Set();
  /** @type {any} */
  let git = null;
  let gitError = '';
  const gitNow = watchGit(threadId);
  gitNow.listen(() => {
    git = gitNow.data;
    gitError = gitNow.error;
    live.held();
  });
  /** Opens Work full screen, at an item or section, or on one turn. */
  const go = (to) => openWork(threadId, { full: true, ...to });

  // A file’s name first, then its folder, so a long path outside the project still shows which file it is.
  // Opened from the lists, a file shows in the pane’s viewer; from a turn, that turn’s change opens full screen.
  const fileRow = (f, to, prefix) =>
    row(
      `${prefix}-${to.at}`,
      () => (to.turn ? go(to) : openWork(threadId, { at: to.at })),
      h('span.mono.wc-name', f.rel.replace(/^.*\//, ''), f.rel.includes('/') ? h('span.dim', ` ${f.rel.replace(/\/[^/]*$/, '')}`) : null),
      flagged(f, git) ? h('span.work-tag.warn', icon('warn', 'i-sm'), 'Review') : null,
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

  /** @param {any} s @param {Set<string>} skip  the files In this chat shows, not listed again */
  function files(s, skip) {
    const groups = fileGroups(
      s.files,
      (f) => fileState(f, git),
      (f) => flagged(f, git),
    );
    const back = s.byState.unchanged.files;
    const edits = editRows(s.edits);
    return sec(
      'wc-files',
      'Files',
      s.total.files + edits.length ? String(s.total.files + edits.length) : '',
      hostNotes(s.turns),
      // What To review said, once: a flagged file carries its tag and goes to the top of Files (#1446).
      s.flagged
        ? h(
            'p.small.wc-flag',
            icon('warn', 'i-sm'),
            `${plural(s.flagged, 'file')} to review: changed outside the project, or git can’t give them back. Postbox kept a copy from before.`,
          )
        : null,
      // The total, when there’s more than one state to add up.
      groups.length > 1 || (back && s.total.files)
        ? h('p.small', plural(s.total.files, 'file'), ' ', signedEl(s.total.added, s.total.deleted), back ? h('span.dim', ` · ${back} put back`) : null)
        : null,
      groups.length
        ? groups.map(({ state: st, files: list }) => {
            const rest = list.filter((f) => !skip.has(f.id));
            return h(
              'div.wc-group',
              h(
                'p.wc-state',
                h('span.status-tag', { class: `ws-${st}` }, STATE_WORDS[st]),
                h('span.small', plural(s.byState[st].files, 'file')),
                signedEl(s.byState[st].added, s.byState[st].deleted),
                rest.length < list.length ? h('span.small.dim', `· ${list.length - rest.length} in In this chat`) : null,
              ),
              short(
                rest,
                (f) => fileRow(f, { at: f.id }, 'wc-file'),
                () => go({ at: 'work-files' }),
              ),
            );
          })
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
          const built = openTurns.has(t.id);
          const d = h(
            'details.wc-turn',
            {
              id: `wturn-${t.id}`,
              class: t.id === target ? 'is-target' : '',
              open: built,
              ontoggle: () => {
                if (d.open === built) return;
                if (d.open) openTurns.add(t.id);
                else openTurns.delete(t.id);
                paint();
              },
            },
            h(
              'summary',
              { id: `wturn-s-${t.id}` },
              icon('right', 'i-sm'),
              h('span.wc-turn-who', h('b', t.handle), h('span.small.dim', ` · ${timeOf(t.startedAt)}`)),
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

  /**
   * More, closed until you open it (#1446): what rarely brings the person to the pane, built only while open.
   * @param {[string, any][]} parts  each section’s name and the section, or null
   */
  function more(parts) {
    const shown = parts.filter(([, x]) => x);
    if (!shown.length) return null;
    const built = moreOpen;
    const d = h(
      'details.wc-more-sec',
      {
        id: 'wc-more',
        open: built,
        ontoggle: () => {
          if (d.open === built) return;
          moreOpen = d.open;
          paint();
        },
      },
      h('summary', { id: 'wc-more-s' }, icon('right', 'i-sm'), h('b', 'More'), h('span.small.dim', shown.map(([name]) => name).join(', '))),
      built
        ? h(
            'div.wc-more-body',
            shown.map(([, x]) => x),
          )
        : null,
    );
    return d;
  }

  const paint = () =>
    keepFocus(body, () => {
      if (full || viewer.open) return;
      const entries = S().work?.[threadId] ?? [];
      const s = summarize(entries, { git });
      const showAll = () => {
        allAssets = true;
        paint();
      };
      // In this chat first, and what it shows isn’t listed again below (#1446).
      const now = chat.current();
      const skip = shownIds(now, allNow);
      const assets = assetsSection(threadId, { all: allAssets, showAll, skip });
      const showShown = () => {
        allShown = true;
        paint();
      };
      const shown = shownSection(threadId, S().apps, { all: allShown, showAll: showShown });
      const lines = s.turns
        .map((t) => ({ t, line: turnLine(entries, t.id) }))
        .filter((x) => x.line)
        .reverse();
      if (!lines.length && !s.files.length && !s.edits.length && !s.commands.length && !s.external.length && !assets && !shown)
        return fill(
          body,
          h('p.empty-note', 'Nothing yet. When an agent edits a file, runs a command or publishes something, it shows here, with what it took.'),
        );
      const showNow = () => {
        allNow = true;
        paint();
      };
      // Commands stay in view while one in the latest turn failed: that’s what needs a look.
      const latest = s.turns.at(-1)?.id;
      const failedNow = s.commands.some((c) => c.turnId === latest && failedCommand(c));
      fill(
        body,
        relevantSection(threadId, now, { all: allNow, showAll: showNow }),
        shown,
        assets,
        files(s, skip),
        failedNow ? commands(s) : null,
        more([
          ['Commands', failedNow ? null : commands(s)],
          ['Outside Postbox', external(s, go)],
          ['Spend', spend(s, go)],
          ['Turns', turns(entries, lines)],
        ]),
      );
    });

  // As in mountWork, what the server sends waits while a press is down (#1010).
  const live = heldFrame(body, paint);
  const chat = chatList(threadId, el, () => live.soon());
  const off = client.on((ch) => {
    const work = (ch.type === 'work.add' || ch.type === 'work.patch') && ch.data.convId === threadId;
    // A message added or finished: In this chat reads the latest ones.
    const said = (ch.type === 'item.add' || ch.type === 'item.patch') && ch.data.threadId === threadId && chat.said();
    if (ch.type === 'load' || ch.type.startsWith('asset') || work || said) live.soon();
  });
  // An asset or file the address names, in place of the lists (#1446).
  const viewer = paneViewer(threadId, el, body, () => paint());
  paint();
  return {
    el,
    /** Opens a turn’s line in the list and scrolls the pane to it; with focus, focus goes to it too. */
    showTurn(turnId, { focus = false } = {}) {
      target = turnId;
      openTurns.add(turnId);
      moreOpen = true;
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
      viewer.destroy();
      chat.destroy();
      live.cancel();
    },
  };
}
