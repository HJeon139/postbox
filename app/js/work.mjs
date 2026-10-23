// The Work view (#132): everything a conversation’s agents changed, ran and published, and what it took, from the
// work ledger (server/ledger.mjs, shared/work.mjs). It covers every session in the conversation, its side and topic
// threads included. Where each change stands (uncommitted, committed, pushed) is asked of git when it opens and
// whenever a turn ends.
//
// It has two forms. In the conversation’s right pane, beside a thread or alone, a compact one (mountWorkPane): what
// needs review, files by where they stand, commands, what was published, spend, and each turn’s line. Expanded, the
// whole of it over the window (mountWork): every file with its diff and Restore, version control, every command with
// its output, and effort by agent.

import { formatDuration } from '/shared/text.mjs';
import { fileEffort, fileState, flagged, formatBytes, formatCost, formatTokens, signed, summarize, turnLine } from '/shared/work.mjs';
import { api, client } from './client.mjs';
import { fill, h, icon, plural, timeOf } from './dom.mjs';
import { closeWork, keepFocus, openDialog, openWork, paneHref, route, toast } from './ui.mjs';

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
const dur = (ms) => (ms ? formatDuration(ms) : '');
const who = (e) => `@${e.handle}${e.who ? ` · ${e.who}` : ''}`;
const priced = (n, has) => (has ? formatCost(n) : '—');

/** The line of counts for files and lines (“3 files · +40 −12”). */
const counts = (t) => [plural(t.files, 'file'), signedEl(t.added, t.deleted)];
/** +a −d, with the signs as text and each count in its color. */
function signedEl(added, deleted) {
  const [a, d] = signed(added, deleted).split(' ');
  return h('span.work-n', h('span.add', a), ' ', h('span.del', d));
}

/**
 * A link to Work as the pane or the expanded view shows it, which replaces the address like the rest of the pane.
 * @param {string} threadId
 * @param {{ turn?: string|null, full?: boolean, at?: string|null }} to
 */
function workLink(threadId, to, ...children) {
  const r = route();
  const href = paneHref(threadId, { side: r.threadId === threadId ? r.sideId : null, work: true, ...to });
  return h(
    'a',
    {
      href,
      onclick: (e) => {
        e.preventDefault();
        openWork(threadId, to);
      },
    },
    ...children,
  );
}

/**
 * Where each change stands, asked of git when Work opens and again once a turn ends, a commit or push lands, or a
 * file is restored. Calls back on every answer.
 * @param {string} threadId
 * @param {() => void} onChange
 */
function watchGit(threadId, onChange) {
  const g = { data: /** @type {any} */ (null), error: '' };
  let timer = 0;
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
    onChange();
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
    stop() {
      off();
      clearTimeout(timer);
    },
  });
}

/**
 * The whole Work view, expanded over the window from the pane.
 * @param {string} threadId  the conversation
 * @param {{ turnId?: string|null, at?: string|null }} [opts]  turnId: show one turn’s work; at: the item or section to
 *   open and go to
 */
export function mountWork(threadId, { turnId = null, at = null } = {}) {
  const el = h('div.work-view', { tabindex: '-1', dataset: { thread: threadId } });
  let handle = null;
  const opened = new Set(at ? [at] : []); // ids of the items you opened, kept across repaints
  const loaded = new Map(); // what a diff or an output request returned, by item
  const asked = new Set();
  /** @type {any} */
  let git = null;
  let gitError = '';
  const gitNow = watchGit(threadId, () => {
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
      fill(el, head(entries, turn), summary(s), filesSection(s, entries), vcsSection(s), externalSection(s), commandsSection(s), effortSection(s, entries));
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

  const section = (id, title, n, ...body) =>
    h('section.work-sec', { id, 'aria-labelledby': `${id}-h` }, h('h2', { id: `${id}-h` }, title, n ? h('span.badge', String(n)) : null), ...body);

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
    return section(
      'work-files',
      'Files',
      files.length,
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
        : h('p.empty-note', 'No files changed yet. A file shows here when an agent’s edit or write changes it.'),
      byAgent.length > 1
        ? h(
            'p.small.dim',
            'By agent: ',
            byAgent.map((a, i) => [i ? ' · ' : '', `@${a.handle} `, ...counts(a)]),
            '. A file’s lines count toward the agent that changed it last.',
          )
        : null,
      h('p.small.dim', 'Changes a command makes (a formatter, a script) aren’t listed: Postbox sees the files an agent edits with its file tools.'),
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

  function diffView(d, f) {
    if (!d) return h('p.small.dim', 'Loading the diff…');
    if (d.error) return h('p.small.dim', `The diff didn’t load: ${d.error}`);
    if (d.tooLarge)
      return h('p.small.dim', `Too large to show: ${formatBytes(d.before.size ?? 0)} → ${formatBytes(d.after.size ?? 0)}. Postbox keeps files up to 4 MB.`);
    if (d.binary)
      return h(
        'p.small.dim',
        `A binary file: ${d.before.exists ? formatBytes(d.before.size) : 'new'} → ${d.after.exists ? formatBytes(d.after.size) : 'deleted'}.`,
      );
    if (!d.rows.length) return h('p.small.dim', 'No difference.');
    return h(
      'div.work-diff-wrap',
      { tabindex: '0', role: 'region', 'aria-label': `Diff of ${f.rel}` },
      h(
        'div.rv-doc.work-diff',
        d.rows.map((r) =>
          r.kind === 'gap'
            ? h('div.work-gap', `⋯ ${plural(r.skipped, 'unchanged line')}`)
            : h(
                `div.rv-line.${r.kind}`,
                h('span.g-ln', { 'aria-label': r.kind === 'add' ? 'added' : r.kind === 'del' ? 'deleted' : null }, String(r.kind === 'del' ? r.o : r.n)),
                h('span.tx', r.t || ' '),
              ),
        ),
      ),
      d.cut ? h('p.small.dim', 'The rest of the diff is too long to show here.') : null,
    );
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

  function vcsSection(s) {
    const rows = [
      ...s.branches.map((b) => ({
        at: b.at,
        el: h('li', icon('right', 'i-sm'), 'Made branch ', h('b.mono', b.name), h('span.small.dim', ` · @${b.handle} · ${timeOf(b.at)}`)),
      })),
      ...s.commits.map((c) => {
        const pushed = git?.commits?.[c.id]?.pushed;
        return {
          at: c.at,
          el: h(
            'li',
            h('span.mono.dim', c.sha.slice(0, 7)),
            ' ',
            h('b', c.message || '(no message)'),
            c.branch ? h('span.small.dim', ` on ${c.branch}`) : null,
            ' · ',
            c.files.length ? [plural(c.files.length, 'file'), ' ', signedEl(c.added, c.deleted)] : 'files unknown',
            ' ',
            h('span.status-tag', { class: pushed ? 'ws-pushed' : 'ws-committed' }, git ? (pushed ? 'Pushed' : 'Not pushed') : '…'),
            h('span.small.dim', ` · @${c.handle} · ${timeOf(c.at)}`),
          ),
        };
      }),
      ...s.pushes.map((p) => ({
        at: p.at,
        el: h(
          'li',
          icon('upload', 'i-sm'),
          ' Pushed ',
          h('b.mono', p.branch || 'a branch'),
          p.remote ? [' to ', h('span.mono', p.remote)] : null,
          p.refs.length ? h('span.small.dim', ` (${p.refs.join(', ')})`) : null,
          h('span.small.dim', ` · @${p.handle} · ${timeOf(p.at)}`),
        ),
      })),
    ].sort((a, b) => a.at - b.at);
    return section(
      'work-vcs',
      'Version control',
      rows.length,
      rows.length
        ? h(
            'ul.work-list',
            rows.map((r) => r.el),
          )
        : h('p.empty-note', 'No branches, commits or pushes yet.'),
    );
  }

  function externalSection(s) {
    return section(
      'work-external',
      'Outside Postbox',
      s.external.length,
      s.external.length
        ? h(
            'ul.work-list',
            s.external.map((x) =>
              h(
                'li',
                h('b', x.what),
                x.via === 'mcp' ? h('span.small.dim', ` (${x.server})`) : null,
                x.state === 'failed' || x.state === 'denied' ? [' ', h('span.status-tag.ws-failed', x.state === 'denied' ? 'Refused' : 'Failed')] : null,
                x.urls?.length
                  ? [
                      ' · ',
                      x.urls.map((u, i) => [
                        i ? ', ' : '',
                        h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u.replace(/^https?:\/\/(www\.)?/, ''), ' ', icon('link', 'i-sm')),
                      ]),
                    ]
                  : null,
                h('span.small.dim', ` · ${who(x)} · ${timeOf(x.at)}`),
              ),
            ),
          )
        : h('p.empty-note', 'Nothing published outside Postbox yet: issues, pull requests and comments an agent writes with gh or a connector show here.'),
    );
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
                  h('code.work-cmd-line', `$ ${c.command.split('\n')[0]}`),
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

  function commandBody(c) {
    const key = `out:${c.id}`;
    if (c.state !== 'running' && c.output?.sha256) load(`${key}:${c.output.sha256}`, `/api/threads/${threadId}/work/commands/${c.id}/output`, 'text');
    const out = c.output?.sha256 ? loaded.get(`${key}:${c.output.sha256}`) : '';
    return [
      c.description ? h('p.small.dim', c.description) : null,
      h('pre.md-code.work-cmd-full', h('code', c.command)),
      h('p.small.dim', `Started ${timeOf(c.startedAt)}${c.who ? ` by the subagent ${c.who}` : ''}.`),
      c.leftRunning ? h('p.small.dim', 'It was still running in the background when the turn ended, so Postbox didn’t see it end.') : null,
      c.endedInBackground ? h('p.small.dim', 'It ran in the background; this is its output file.') : null,
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

  function effortSection(s, entries) {
    const anyPrice = s.effort.priced;
    const row = (a, total = false) =>
      h(
        'tr',
        { class: total ? 'work-total' : '' },
        h(total ? 'th' : 'td', { scope: total ? 'row' : null }, total ? 'All' : `@${a.handle}`),
        h('td.num', a.turns.toLocaleString('en-US')),
        h('td.num', dur(a.ms) || '—'),
        h('td.num', a.toolCalls.toLocaleString('en-US')),
        h('td.num', a.tokens ? formatTokens(a.tokens) : '—'),
        h('td.num', priced(a.costUsd, anyPrice)),
        h('td.num', `+${(a.written ?? 0).toLocaleString('en-US')}`),
        h('td.num', signedEl(a.added, a.deleted)),
      );
    const idle = s.idle.list;
    return section(
      'work-effort',
      'Effort',
      0,
      s.turns.length
        ? h(
            'div.tbl-wrap.work-tbl',
            { tabindex: '0', role: 'region', 'aria-label': 'Effort by agent' },
            h(
              'table.tbl',
              h(
                'thead',
                h(
                  'tr',
                  ['Agent', 'Turns', 'Time', 'Tool calls', 'Tokens', 'Spend', 'Written', 'Kept'].map((x, i) =>
                    h('th', { scope: 'col', class: i ? 'num' : '' }, x),
                  ),
                ),
              ),
              h(
                'tbody',
                s.byAgent.map((a) => row(a)),
              ),
              s.byAgent.length > 1
                ? h(
                    'tfoot',
                    row({ handle: '', ...s.effort, tokens: s.effort.tokens, written: s.effort.written, added: s.total.added, deleted: s.total.deleted }, true),
                  )
                : null,
            ),
          )
        : h('p.empty-note', 'No turns yet.'),
      anyPrice || !s.turns.length ? null : h('p.small.dim', 'Spend shows for Claude Code and Agent SDK turns.'),
      idle.length
        ? [
            h('h3.label', 'Left nothing lasting'),
            h(
              'ul.work-list',
              idle.map((t) => {
                const cmds = s.commands.filter((c) => c.turnId === t.id);
                const failed = cmds.filter((c) => c.state === 'failed').length;
                const files = entries.filter((e) => e.kind === 'change' && e.turnId === t.id).length;
                return h(
                  'li',
                  workLink(threadId, { full: true, turn: t.id }, `@${t.handle} at ${timeOf(t.startedAt)}`),
                  h(
                    'span.small.dim',
                    ` · ${[dur(t.ms), anyPrice ? formatCost(t.costUsd ?? 0) : null, cmds.length ? `${plural(cmds.length, 'command')}${failed ? `, ${failed} failed` : ''}` : null, files ? `${plural(files, 'file')} put back` : null].filter(Boolean).join(' · ')}`,
                  ),
                );
              }),
            ),
          ]
        : null,
    );
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
      gitNow.stop();
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
 * short, and each item opens in the expanded view. Nothing here moves or pulses: it’s a record, read when you look.
 * @param {string} threadId  the conversation
 */
export function mountWorkPane(threadId) {
  const body = h('div.wp-body', { tabindex: '-1' });
  const el = h(
    'aside.workpane',
    { id: 'work-pane', 'aria-labelledby': 'wp-title', dataset: { thread: threadId } },
    h(
      'div.wp-head',
      icon('file', 'dim'),
      h('div.grow', h('b', { id: 'wp-title' }, 'Work'), h('div.small.dim', 'What the agents changed, ran and published')),
      h('button.btn.sm', { type: 'button', id: 'work-expand', onclick: () => openWork(threadId, { full: true }) }, icon('expand', 'i-sm'), 'Expand'),
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
  const gitNow = watchGit(threadId, () => {
    git = gitNow.data;
    gitError = gitNow.error;
    paint();
  });
  /** Opens the expanded view, at an item or section, or on one turn. */
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
    return sec(
      'wc-files',
      'Files',
      s.total.files ? String(s.total.files) : '',
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
        : h('p.empty-note', back ? 'Every changed file was put back.' : 'No files changed yet.'),
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
      const entries = S().work?.[threadId] ?? [];
      const s = summarize(entries, { git });
      const lines = s.turns
        .map((t) => ({ t, line: turnLine(entries, t.id) }))
        .filter((x) => x.line)
        .reverse();
      if (!lines.length && !s.files.length && !s.commands.length && !s.external.length)
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
    destroy() {
      off();
      gitNow.stop();
      cancelAnimationFrame(frame);
    },
  };
}
