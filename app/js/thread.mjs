// The conversation view: transcript, composer, and the panel beside it for topic threads (yours, forked from a
// message) and side threads (between agents).

import { renderMarkdown } from '/shared/markdown.mjs';
import { enhanceMarkdown, renderAppItem } from './apps.mjs';
import { renderBlock } from './blocks.mjs';
import { api, busy, client, hrefOf, itemsOf, sessionsOf, uploadFile } from './client.mjs';
import { $, ago, dayOf, fill, h, icon, plural, syncList, timeOf, trusted } from './dom.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { openAttachSession, openFolderPicker, openNewAgent } from './sheets.mjs';
import { announceStreaming, navigate, openMenu, say, toast } from './ui.mjs';

const S = () => client.state;
const handles = () =>
  Object.values(S().personas)
    .filter((p) => !p.retired)
    .map((p) => p.handle);
const glossaryOf = (threadId) => {
  const t = S().threads[threadId];
  const g = { ...(S().glossary[t?.parentId] ?? {}), ...(S().glossary[threadId] ?? {}) };
  return g;
};
const speaker = (it) => (it.kind === 'user' ? 'you' : it.kind === 'agent' || it.kind === 'block' || it.kind === 'proposal' ? `s:${it.sessionId}` : null);

// ── Transcript ──────────────────────────────────────────────────────────────────────────

/** A live transcript for one thread. Returns { el, destroy }. */
export function mountTranscript(threadId, { inPanel = false } = {}) {
  const el = h('div.transcript', { id: inPanel ? null : 'main', tabindex: '-1', 'aria-label': 'Conversation', dataset: { thread: threadId } });
  const nodes = new Map();
  const pending = new Set();
  let raf = 0;
  let unseen = 0;
  // At the end of the transcript, one row per agent that’s thinking or calling tools: what it’s on right now,
  // and a glimpse of its thinking. It goes while the agent writes, since the reply itself shows then.
  const working = h('div.working', { 'aria-hidden': 'true' });
  const paintWorking = () => {
    const busy = sessionsOf(threadId).filter((se) => !se.archived && (se.state === 'think' || se.state === 'tool'));
    syncList(
      working,
      busy,
      (se) => se.id,
      (se) => {
        const row = h('div.work-row', ringFor(se, 'xs'), h('div.work-text'));
        fillWorkRow(row, se);
        return row;
      },
      (row, se) => fillWorkRow(row, se),
    );
    el.append(working); // keep it last
  };

  const appSig = (app) => JSON.stringify([app.current, app.versions?.length, app.check?.status, app.check?.problems?.length ?? 0]);
  const render = (it, prev) => {
    const ctx = { threadId, kind: S().threads[threadId]?.kind, rerender: () => rerender(it.id) };
    const node = renderItem(it, prev, ctx);
    messageActions(node, it, ctx);
    node.dataset.key = it.id;
    if (it.kind === 'block' && it.valid && it.block.type === 'app' && S().apps[it.block.id]) node.dataset.appSig = appSig(S().apps[it.block.id]);
    node.classList.add('item');
    if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
    return node;
  };
  const rerender = (id) => {
    const list = itemsOf(threadId);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const old = nodes.get(id);
    // Keep focus inside a block that’s being edited.
    const hadFocus = old?.contains(document.activeElement) ? document.activeElement : null;
    const n = render(list[i], list[i - 1]);
    old?.replaceWith(n);
    nodes.set(id, n);
    if (hadFocus?.id) document.getElementById(hadFocus.id)?.focus();
  };
  const all = () => {
    el.replaceChildren();
    nodes.clear();
    const list = itemsOf(threadId);
    if (!list.length && !inPanel) {
      el.append(welcome(threadId));
      return;
    }
    list.forEach((it, i) => {
      const n = render(it, list[i - 1]);
      nodes.set(it.id, n);
      el.append(n);
    });
    paintWorking();
  };
  all();

  const nearBottom = () =>
    (inPanel ? el.parentElement : document.scrollingElement) &&
    (inPanel
      ? el.parentElement.scrollHeight - el.parentElement.scrollTop - el.parentElement.clientHeight < 160
      : innerHeight + scrollY >= document.documentElement.scrollHeight - 160);
  const scrollToEnd = (smooth = false) => {
    const target = inPanel ? el.parentElement : null;
    if (target) target.scrollTop = target.scrollHeight;
    else
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
      });
    unseen = 0;
    jump?.(0);
  };
  let jump = null;
  const grew = (wasNear) => {
    if (wasNear) requestAnimationFrame(() => scrollToEnd());
    else {
      unseen++;
      jump?.(unseen);
    }
  };

  const off = client.on((ch) => {
    if (ch.type === 'load') {
      all();
      return;
    }
    const d = ch.data;
    if (ch.type === 'item.add' && d.threadId === threadId) {
      const near = nearBottom();
      if (nodes.size === 0) el.replaceChildren();
      const list = itemsOf(threadId);
      const n = render(d.item, list[list.length - 2]);
      nodes.set(d.item.id, n);
      el.append(n);
      paintWorking();
      grew(near);
    } else if (ch.type === 'item.patch' && d.threadId === threadId) {
      rerender(d.id);
    } else if (ch.type === 'item.text' && d.threadId === threadId) {
      pending.add(d.id);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          const near = nearBottom();
          for (const id of pending) updateText(id);
          pending.clear();
          if (near) scrollToEnd();
        });
    } else if (ch.type === 'glossary' && d.threadId === threadId) {
      for (const it of itemsOf(threadId)) if (it.kind === 'agent') updateText(it.id, true);
    } else if (ch.type === 'session') {
      el.querySelectorAll(`pb-ring[data-session="${CSS.escape(d.id)}"]`).forEach((r) => {
        ringFor(d, r.getAttribute('size'), r);
      });
      if (d.threadId === threadId) {
        const near = nearBottom();
        const had = working.childElementCount;
        paintWorking();
        if (near && working.childElementCount !== had) requestAnimationFrame(() => scrollToEnd());
      }
    } else if (ch.type === 'app') {
      for (const it of itemsOf(threadId))
        if (it.kind === 'block' && it.valid && (it.block.id === d.id || it.block.appId === d.id)) {
          if (it.block.type === 'app') {
            // Only what changes the frame re-renders it: a new version, a version picked, or the check’s result.
            // Saved state never does; the running app already has it, and reloading would make it save again.
            const sig = appSig(d);
            const node = nodes.get(it.id);
            if (node?.dataset.appSig !== sig) {
              rerender(it.id);
              const fresh = nodes.get(it.id);
              if (fresh) fresh.dataset.appSig = sig;
            }
          } else if (it.block.type === 'review' && it.block.format === 'app') {
            // The review frame keeps its draft; only re-render when the app’s version changed.
            const prev = nodes.get(it.id)?.dataset.appVersion;
            if (prev !== String(d.current)) rerender(it.id);
          }
        }
    }
  });

  const updateText = (id, force = false) => {
    const it = itemsOf(threadId).find((x) => x.id === id);
    const node = nodes.get(id);
    if (!it || !node) return;
    const box = node.querySelector(':scope > .md');
    if (!box) {
      rerender(id);
      return;
    }
    box.innerHTML = agentMarkdown(it, threadId); // lint-allow dom: renderMarkdown() output, escaped.
    markTerms(box, threadId);
    if (it.status === 'streaming') box.append(h('span.caret', { 'aria-hidden': 'true' }));
    else enhanceMarkdown(box);
    if (!force) announceStreaming(it.id, it.text, it.status !== 'streaming', `@${it.handle}`);
  };

  return {
    el,
    scrollToEnd,
    setJump(fn) {
      jump = fn;
    },
    destroy: off,
  };
}

function fillWorkRow(row, se) {
  ringFor(se, 'xs', row.querySelector('pb-ring'));
  const step = se.state === 'tool' && se.currentStep ? `: ${se.currentStep}` : '';
  fill(
    row.querySelector('.work-text'),
    h('div', h('b', `@${se.handle}`), h('span.dim', ` · ${stateWord(se.state).toLowerCase()}${step}`)),
    se.glimpse ? h('div.glimpse', se.glimpse) : null,
  );
}

function agentMarkdown(it, threadId) {
  return renderMarkdown(it.text ?? '', {
    streaming: it.status === 'streaming',
    citations: it.sources?.length ?? 0,
    citeId: `src-${it.id}`,
    glossary: Object.values(glossaryOf(threadId)).map((g) => ({ key: g.key, term: g.term })),
    mentions: handles(),
  });
}

function markTerms(root, threadId) {
  const g = glossaryOf(threadId);
  for (const t of root.querySelectorAll('.term')) {
    const known = !!g[t.dataset.term];
    t.classList.toggle('undef', !known);
    if (!known) t.title = 'Not defined yet. The agent has been asked to define it.';
  }
}

const who = (it, { you = false } = {}) => {
  const se = S().sessions[it.sessionId];
  const ts = h('span.ts', { title: `${dayOf(it.at)} ${timeOf(it.at)}` }, `${timeOf(it.at)}`);
  // A turn typed into Claude Code in a terminal, mirrored here, says so.
  const via = it.via === 'terminal' ? h('span.via', 'from terminal') : null;
  if (you) return h('div.who', ts, h('b', 'You'), via);
  const ring = se ? ringFor(se, 'xs') : h('pb-ring', { name: `@${it.handle}`, state: 'idle', ctx: '0', size: 'xs' });
  if (se) ring.dataset.session = se.id;
  const state = se ? h('span.who-state', { dataset: { session: se.id, item: it.id }, 'aria-live': 'off' }) : null;
  return h('div.who', ring, h('b', `@${it.handle}`), state, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, ts);
};

// Under a message in a conversation: “Reply in thread”, or once a thread exists, “3 replies”. Under a reply in a
// topic thread: “Send to conversation”. The actions appear on hover and focus, and always on touch screens.
function messageActions(node, it, ctx) {
  if (!['user', 'agent', 'block', 'shared'].includes(it.kind) || it.status === 'streaming' || it.deletedAgent) return;
  if (it.kind === 'block' && !it.valid) return;
  const bar = h('div.msg-actions');
  if (ctx.kind === 'thread' || ctx.kind === 'room') {
    const topic = it.topicId && S().threads[it.topicId];
    if (topic) {
      const unread = sessionsOf(topic.id).reduce((a, x) => a + (x.unread ?? 0), 0);
      bar.append(
        h(
          'a.replies',
          { href: hrefOf(topic.id) },
          icon('thread', 'i-sm'),
          it.replies ? plural(it.replies, 'reply', 'replies') : 'Thread',
          it.lastReplyAt ? h('span.dim', ` · last reply ${ago(it.lastReplyAt)}`) : null,
          unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
        ),
      );
    } else
      bar.append(
        h(
          'button.btn.sm.ghost.reveal',
          {
            type: 'button',
            onclick: () =>
              api(`/api/threads/${ctx.threadId}/items/${it.id}/topic`, {})
                .then((r) => {
                  navigate(`#/t/${ctx.threadId}/side/${r.threadId}`);
                  setTimeout(() => $('#side-input')?.focus(), 150);
                })
                .catch((e) => toast({ title: 'Couldn’t start a thread', text: e.message, level: 'blocking' })),
          },
          icon('thread', 'i-sm'),
          'Reply in thread',
        ),
      );
  } else if (ctx.kind === 'topic' && (it.kind === 'agent' || it.kind === 'user') && it.text) {
    bar.append(
      it.sharedAt
        ? h('span.small.dim', icon('check', 'i-sm'), ' Sent to the conversation')
        : h(
            'button.btn.sm.ghost.reveal',
            {
              type: 'button',
              onclick: () =>
                api(`/api/threads/${ctx.threadId}/items/${it.id}/share`, {})
                  .then(() => toast({ title: 'Sent to the conversation', text: 'Its agents read it at the start of their next turn.' }))
                  .catch((e) => toast({ title: 'Couldn’t send it', text: e.message, level: 'blocking' })),
            },
            icon('right', 'i-sm'),
            'Send to conversation',
          ),
    );
  }
  if (bar.childNodes.length) node.append(bar);
}

function renderItem(it, prev, ctx) {
  const showWho = !(prev && speaker(prev) && speaker(prev) === speaker(it) && prev.kind !== 'voice');
  switch (it.kind) {
    case 'user': {
      return h(
        'div.col.turn.me',
        showWho ? who(it, { you: true }) : null,
        h(
          'div.me-card',
          h('div.md', { html: trusted(renderMarkdown(it.text, { mentions: handles() })) }),
          it.attachments?.length ? h('div.attachments', it.attachments.map(attChip)) : null,
        ),
      );
    }
    case 'agent': {
      const steps = it.activity?.steps ?? [];
      const total = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
      const running = steps.some((s) => s.state === 'running');
      const node = h(
        'div.col.turn',
        showWho ? who(it) : null,
        steps.length
          ? h(
              'details.activity',
              h(
                'summary',
                icon('right', 'i-sm'),
                activityLabel(steps),
                total ? ` · ${(total / 1000).toFixed(total < 10000 ? 1 : 0)} s` : '',
                running ? ' · running' : '',
              ),
              h('ul.steps', steps.map(stepRow)),
            )
          : null,
        it.text || it.status === 'streaming' ? h('div.md') : null,
        it.status === 'stopped' ? h('span.stopped-tag', `Stopped by you at ${timeOf(it.stoppedAt ?? it.at)}`) : null,
        it.status === 'failed'
          ? h(
              'div.callout',
              { role: 'alert' },
              h('span.g.g-failed', { 'aria-hidden': 'true' }),
              h('div.grow', ...failureText(it.error)),
              h(
                'button.btn.sm',
                {
                  type: 'button',
                  onclick: () =>
                    api(`/api/threads/${ctx.threadId}/items/${it.id}/retry`, {}).catch((e) =>
                      toast({ title: 'Retry didn’t start', text: e.message, level: 'blocking' }),
                    ),
                },
                icon('retry', 'i-sm'),
                'Retry',
              ),
            )
          : null,
        it.status === 'retried' ? h('span.stopped-tag', 'Retried below') : null,
        it.sources?.length
          ? h(
              'details.sources',
              { open: true },
              h('summary', `Sources · ${it.sources.length}`),
              h(
                'ol',
                it.sources.map((s, i) =>
                  h(
                    'li',
                    { id: `src-${it.id}-${i + 1}` },
                    s.authors ? `${s.authors.split(',')[0]}${s.authors.includes(',') ? ' et al.' : ''} ` : '',
                    s.year ? `(${s.year}). ` : '',
                    h('i', s.title),
                    '. ',
                    s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, '')) : null,
                  ),
                ),
              ),
            )
          : null,
      );
      const box = node.querySelector(':scope > .md');
      if (box) {
        box.innerHTML = agentMarkdown(it, ctx.threadId); // lint-allow dom: renderMarkdown() output, escaped.
        markTerms(box, ctx.threadId);
        if (it.status === 'streaming') box.append(h('span.caret', { 'aria-hidden': 'true' }));
        else queueMicrotask(() => enhanceMarkdown(box));
      }
      return node;
    }
    case 'block': {
      if (it.valid && it.block.type === 'app') {
        const n = h('div.wide', renderAppItem(it, ctx));
        return n;
      }
      const act = async (action, values) => {
        const r = await api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values });
        focusComposer();
        return r;
      };
      const node = h('div.col.turn', showWho ? who(it) : null, renderBlock(it, { act, threadId: ctx.threadId }));
      if (it.valid && it.block.type === 'review' && it.block.format === 'app') node.dataset.appVersion = String(S().apps[it.block.appId]?.current ?? '');
      return node;
    }
    case 'voice':
      return h('div.col.turn.me', h('span.voice', icon('thread', 'i-sm'), it.text));
    case 'shared':
      // A reply or a summary sent back from a topic thread. Its agents read it at the start of their next turn.
      return h(
        'div.col.turn',
        h(
          'div.shared-card',
          h(
            'div.shared-head',
            icon('thread', 'i-sm'),
            h('span.grow', it.summary ? 'Summary of the thread ' : 'From the thread ', h('b', `“${it.fromTitle}”`), it.handle ? ` · @${it.handle}` : ' · you'),
            S().threads[it.fromThreadId] ? h('a.small', { href: hrefOf(it.fromThreadId) }, 'Open thread') : null,
          ),
          h('div.md', { html: trusted(renderMarkdown(it.text, { mentions: handles() })) }),
        ),
      );
    case 'system':
      return systemLine(it, ctx);
    case 'sidelink':
      return h(
        'div.col.sys',
        h(
          'a.pill',
          { href: `#/t/${ctx.threadId}/side/${it.sideThreadId}`, style: { textDecoration: 'none', borderColor: 'var(--accent)' } },
          icon('thread', 'i-sm'),
          h('b', `@${it.from}`),
          ' asked ',
          h('b', `@${it.to}`),
          ` · ${plural(it.count ?? 0, 'message')} · Open`,
        ),
      );
    case 'hop':
      return hopBlock(it, ctx);
    case 'permission':
      return permissionBlock(it, ctx);
    case 'denial':
      return denialBlock(it, ctx);
    case 'proposal':
      return proposalBlock(it, ctx, showWho);
    default:
      return h('div.col.small.dim', `Unknown item “${it.kind}”.`);
  }
}

function failureText(msg = 'This reply didn’t finish.') {
  const m = msg.match(/^(.*?[.!?])\s+([\s\S]*)$/);
  return m ? [h('b', m[1]), ' ', m[2]] : [h('b', msg)];
}

function activityLabel(all) {
  const steps = all.filter((s) => s.kind !== 'thought');
  const thoughts = all.length - steps.length;
  const refused = steps.filter((s) => s.state === 'denied').length;
  const reads = steps.filter((s) => /^(read|grep|arxiv\.fetch|corpus\.read)/.test(s.label)).length;
  const verb = steps.some((s) => s.label.startsWith('grep')) ? 'Searched' : 'Read';
  const used = !steps.length
    ? null
    : reads === steps.length
      ? `${verb} ${plural(steps.length, steps.some((s) => s.label.startsWith('arxiv')) ? 'paper' : 'file')}`
      : `Used ${plural(steps.length, 'tool')}`;
  return [used, thoughts ? plural(thoughts, 'thought') : null, refused ? `${refused} refused` : null].filter(Boolean).join(' · ');
}

// One step in an agent’s activity list: a tool call (the agent’s or a subagent’s), or a thought, which opens
// to its whole text. A failed step says why; a refused one points to its card.
const GLYPH = { running: 'running', failed: 'failed', denied: 'failed', done: 'done' };
function stepRow(s) {
  const dur = h('span.dur', s.ms ? `${(s.ms / 1000).toFixed(1)} s` : '');
  if (s.kind === 'thought')
    return h(
      'li.thought',
      h('span.g.g-thought', { role: 'img', 'aria-label': 'thought' }),
      h('details.step-text', h('summary', s.label), s.detail && s.detail !== s.label ? h('p', s.detail) : null),
      dur,
    );
  const note = s.state === 'denied' ? 'Refused: see the card below.' : s.state === 'failed' ? s.detail : null;
  return h(
    'li',
    { class: s.state === 'denied' ? 'denied' : '' },
    h(`span.g.g-${GLYPH[s.state] ?? 'done'}`, { role: 'img', 'aria-label': s.state === 'denied' ? 'refused' : s.state }),
    h('span.step-text', s.who ? h('span.step-who', `${s.who} ·`) : null, h('span.mono', s.label), note ? h('span.step-note', note) : null),
    dur,
  );
}

function attChip(a) {
  const label = a.kind === 'project-file' ? a.path : a.name;
  return h(
    'span.att',
    h('span.thumb', icon(a.kind === 'project-file' ? 'folder' : /^image\//.test(a.type ?? '') ? 'image' : 'file', 'i-sm')),
    a.fileId ? h('a', { href: `/api/files/${a.fileId}`, style: { color: 'inherit' } }, label) : label,
    a.size ? h('span.dim', ` · ${a.size > 1e6 ? (a.size / 1e6).toFixed(1) + ' MB' : Math.ceil(a.size / 1000) + ' KB'}`) : null,
  );
}

function systemLine(it, _ctx) {
  switch (it.variant) {
    case 'attached':
      return h(
        'div.col.sys-line',
        icon('link', 'i-sm'),
        h('b', `@${it.handle}`),
        ' is a Claude Code session from ',
        h('span.mono', it.folder ?? 'a terminal'),
        '. What you type there shows up here too.',
      );
    case 'wake':
      if (it.scheduled) return h('div.col.sys-line', icon('clock', 'i-sm'), h('b', `@${it.to}`), ' woke itself, as scheduled');
      return h(
        'div.col.sys-line',
        icon('agent', 'i-sm'),
        it.from === 'you'
          ? ['You woke ', h('b', `@${it.to}`)]
          : [h('b', `@${it.from}`), ' woke ', h('b', `@${it.to}`), it.n ? ` · agent wake ${it.n} of ${it.limit ?? 3}` : ''],
      );
    case 'compaction': {
      const sum = h(
        'div.block',
        { hidden: true, style: { marginTop: '8px' } },
        h('div.block-head', h('span.title.grow', `What @${it.handle} kept`), h('span.kind', 'Compaction')),
        h('div.block-body', h('div.md', { html: trusted(renderMarkdown(it.summary || 'No summary was kept.')) })),
      );
      const btn = h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          'aria-expanded': 'false',
          onclick: () => {
            sum.hidden = !sum.hidden;
            btn.textContent = sum.hidden ? 'Show summary' : 'Hide summary';
            btn.setAttribute('aria-expanded', String(!sum.hidden));
          },
        },
        'Show summary',
      );
      return h(
        'div.col',
        h(
          'div.sys',
          h(
            'span.pill',
            icon('archive', 'i-sm'),
            'Context compacted · ',
            h('b', `@${it.handle}`),
            ` #${it.n} · kept ${Math.round(it.kept / 1000)}k of ${Math.round(it.total / 1000)}k tokens`,
            btn,
          ),
        ),
        sum,
      );
    }
    case 'schedule':
      return h(
        'div.col.sys-line',
        icon('clock', 'i-sm'),
        h('b', `@${it.handle}`),
        it.status === 'pending'
          ? ` will wake itself at ${timeOf(it.at)}`
          : it.status === 'canceled'
            ? ' won’t wake itself (canceled)'
            : ` woke itself at ${timeOf(it.at)}`,
        it.note ? ` · “${it.note}”` : '',
        it.status === 'pending'
          ? [
              ' · ',
              h(
                'button.btn.sm.ghost',
                {
                  type: 'button',
                  onclick: () => api(`/api/schedules/${it.scheduleId}/cancel`, {}).catch((e) => toast({ title: 'Couldn’t cancel', text: e.message })),
                },
                'Cancel',
              ),
            ]
          : null,
      );
    case 'joined':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' joined');
    case 'left':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' left (its session was deleted)');
    default:
      return h('div.col.sys-line', it.text ?? '');
  }
}

function hopBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (allow) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: allow ? 'confirm' : 'cancel' })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  return h(
    'div.col.block',
    { role: 'group', class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', `Let @${it.from} wake @${it.to}?`),
      h('span.kind', 'Confirm · from Postbox'),
    ),
    h(
      'div.block-body.md',
      h('p', `That would be agent wake ${it.n} since your last message. After 3 in a row, the next one waits for you.`),
      it.reason ? h('p.dim.small', `@${it.from}’s reason: “${it.reason}”`) : null,
      !open ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'allowed' ? 'Allowed' : 'Not allowed') : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act(true) }, `Let @${it.from} wake @${it.to}`),
          h('button.btn', { type: 'button', onclick: () => act(false) }, `Don’t wake @${it.to}`),
        )
      : null,
  );
}

// An agent in “ask” mode waits here before a risky tool call. It isn’t a catalog block: Postbox draws it,
// and your answer goes straight back to the waiting tool call rather than to the agent as a message.
const PERMISSION_DONE = { allowed: 'Allowed', denied: 'Not allowed', expired: 'Expired: the turn ended before you answered' };
function permissionBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `pm-${it.id}`;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `Let @${it.handle} ${it.summary}?`),
      h('span.kind', `Permission · ${it.tool}`),
    ),
    h(
      'div.block-body',
      // The whole command, wrapped: you decide on what you can see.
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail)) : null,
      !open ? h('span.answered-note', icon(it.status === 'allowed' ? 'check' : 'x', 'i-sm'), PERMISSION_DONE[it.status] ?? it.status) : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('allow') }, 'Allow'),
          h('button.btn', { type: 'button', onclick: () => act('deny') }, 'Don’t allow'),
          h('span.small.dim', `@${it.handle} is waiting for you.`),
        )
      : null,
  );
}

// Claude Code refused a call without asking you (auto mode’s check, a rule, or the mode). Unlike a permission
// card nothing is waiting: Allow once or Always allow tells the agent to try again.
const DENIAL_DONE = {
  'allowed-once': 'Allowed once. The agent is trying again.',
  'allowed-always': 'Always allowed. The agent is trying again.',
  left: 'Left refused.',
};
const DENIAL_WHY = {
  classifier: 'auto mode’s safety check',
  rule: 'a permission rule',
  subcommandResults: 'a permission rule',
  mode: 'the permission mode',
  asyncAgent: 'a background subagent can’t ask you',
};
function denialBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `dn-${it.id}`;
  const by = it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `Refused: ${by} tried to ${it.summary.charAt(0).toLowerCase()}${it.summary.slice(1)}`),
      h('span.kind', `Refused · ${it.tool}`),
    ),
    h(
      'div.block-body',
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail)) : null,
      it.reason || DENIAL_WHY[it.reasonType]
        ? h('p.small', h('b', 'Why: '), it.reason || '', DENIAL_WHY[it.reasonType] ? ` (${DENIAL_WHY[it.reasonType]})` : '')
        : null,
      open
        ? h(
            'p.small.dim',
            'Always allow adds ',
            h('code', it.rules.always),
            ' to .claude/settings.local.json in the agent’s folder, so your terminal sessions follow it too. A deny rule in your Claude Code settings still wins.',
          )
        : h('span.answered-note', icon(it.status === 'left' ? 'x' : 'check', 'i-sm'), DENIAL_DONE[it.status] ?? it.status),
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('once') }, 'Allow once and retry'),
          h('button.btn', { type: 'button', onclick: () => act('always') }, `Always allow ${it.rules.alwaysWords}`),
          h('button.btn.ghost', { type: 'button', onclick: () => act('leave') }, 'Leave it'),
        )
      : null,
  );
}

const BACKEND_NAMES = { 'claude-code': 'Claude Code', 'agent-sdk': 'Agent SDK', mock: 'Mock agent' };

function proposalBlock(it, ctx, showWho) {
  const p = it.proposal;
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  return h(
    'div.col.turn',
    showWho ? who(it) : null,
    h(
      'div.block',
      { role: 'group', class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
      h('div.block-head', icon('spark'), h('span.title.grow', `New teammate: @${p.handle}`), h('span.kind', `Proposed by @${it.handle}`)),
      h(
        'div.block-body',
        h('p', String(p.description ?? '')),
        h(
          'dl.facts',
          h('dt', 'Runs on'),
          h('dd', BACKEND_NAMES[S().personas[S().sessions[it.sessionId]?.personaId]?.backend] ?? 'Mock agent', ', asking before anything risky'),
          h('dt', 'Tools'),
          h(
            'dd',
            h(
              'div.chips',
              p.tools.map((t) => h('span.pill', { style: it.extraTools.includes(t) ? { borderColor: 'var(--accent)' } : {} }, h('b', { class: 'mono' }, t))),
            ),
            it.extraTools.length
              ? h(
                  'span.err',
                  { style: { color: 'var(--accent)' } },
                  icon('warn'),
                  `${it.extraTools.join(', ')} ${it.extraTools.length === 1 ? 'is' : 'are'} more than @${it.handle} has. Creating @${p.handle} grants ${it.extraTools.length === 1 ? 'it' : 'them'}.`,
                )
              : null,
          ),
          h('dt', 'Joins'),
          h('dd', `This ${ctx.kind === 'topic' ? 'topic thread' : ctx.kind === 'side' ? 'side thread' : 'conversation'}, with the recent messages as context`),
        ),
        !open ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'created' ? `Created @${p.handle}` : 'Dismissed') : null,
      ),
      open
        ? h(
            'div.block-foot',
            h('button.btn', { type: 'button', onclick: () => act('create') }, `Create @${p.handle}`),
            h(
              'button.btn',
              { type: 'button', onclick: () => openNewAgent({ threadId: ctx.threadId, preset: p, onCreated: () => act('dismiss') }) },
              'Edit first',
            ),
            h('button.btn.ghost', { type: 'button', onclick: () => act('dismiss') }, 'Dismiss'),
          )
        : null,
    ),
  );
}

function welcome(threadId) {
  const se = sessionsOf(threadId)[0];
  const p = se && S().personas[se.personaId];
  if (!se || !p) return h('div.col', h('p.dim', 'No agent is in this conversation yet. @-mention one to bring it in.'));
  const ring = ringFor(se, 'lg');
  ring.dataset.session = se.id;
  return h(
    'section.col',
    { style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '32px 0' } },
    h('div.row-flex', { style: { gap: '14px' } }, ring, h('div', h('h1.title', `@${p.handle} is ready`), h('p.dim', String(p.description ?? '')))),
    h(
      'div',
      { role: 'list', 'aria-label': 'Example prompts', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
      (p.examples ?? []).map(([title, sub]) =>
        h(
          'button.prompt',
          {
            type: 'button',
            role: 'listitem',
            style: {
              all: 'unset',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '12px',
              border: '1px solid var(--line-strong)',
              borderRadius: '8px',
              background: 'var(--panel)',
            },
            onclick: () => sendMessage(threadId, title),
          },
          h('b', title),
          h('span.small.dim', sub),
        ),
      ),
    ),
  );
}

// ── Composer ────────────────────────────────────────────────────────────────────────────

// Messages typed while offline. Kept in localStorage so a reload doesn’t lose them, and sent whenever the
// connection returns, whether or not a composer is open.
const OUTBOX_KEY = 'pb-outbox';
const outbox = (() => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]');
  } catch {
    return [];
  }
})();
const saveOutbox = () => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {}
};
client.on((ch) => {
  if (ch.type === 'connection' && client.connection === 'open') flushOutbox();
});
export const focusComposer = () => $('#composer-input')?.focus();

export async function sendMessage(threadId, text, attachments = [], { sendNow = false } = {}) {
  try {
    const r = await api(`/api/threads/${threadId}/messages`, { text, attachments, sendNow });
    if (r.queued) say('Queued. It sends when the agent finishes.');
    return true;
  } catch (e) {
    if (e.offline) {
      outbox.push({ threadId, text, attachments });
      saveOutbox();
      client.emit({ type: 'outbox' });
      return true;
    }
    toast({ title: 'Your message didn’t send', text: e.message, level: 'blocking' });
    return false;
  }
}

export function flushOutbox() {
  const items = outbox.splice(0);
  saveOutbox();
  for (const m of items) sendMessage(m.threadId, m.text, m.attachments);
  if (items.length) client.emit({ type: 'outbox' });
}

export function mountComposer(threadId, { side = false } = {}) {
  const topic = S().threads[threadId]?.kind === 'topic';
  const key = `pb-draft-${threadId}`;
  let attachments = [];
  let mention = null; // { start, query, index }
  const ta = h('textarea', {
    id: side ? 'side-input' : 'composer-input',
    rows: '1',
    'aria-label': topic ? 'Reply in thread' : side ? 'Message the side thread' : 'Message',
    autocomplete: 'off',
  });
  try {
    ta.value = localStorage.getItem(key) ?? '';
  } catch {}
  const plus = h('button.btn.icon.ghost', {
    type: 'button',
    'aria-label': 'Add a file or a new agent',
    'aria-haspopup': 'menu',
    onclick: () => plusMenu(plus),
  });
  plus.append(icon('plus'));
  const action = h('button.btn', { type: 'button' });
  const att = h('div.attachments', { role: 'group', 'aria-label': 'Attachments' });
  const queue = h('div.outbox');
  const status = h('div');
  const hint = h('div.hint');
  const menuBox = h('div', { style: { position: 'relative' } });
  const file = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      addFiles([...file.files]);
      file.value = '';
    },
  });
  const corpusFile = h('input', {
    type: 'file',
    accept: '.txt,.md,text/plain,text/markdown',
    hidden: true,
    onchange: async () => {
      for (const f of corpusFile.files) {
        try {
          const up = await uploadFile(f);
          await api('/api/corpus', { fileId: up.id });
          toast({ title: `Added ${f.name} to the corpus`, text: 'It’s searchable now.' });
        } catch (e) {
          toast({ title: `Couldn’t add ${f.name}`, text: e.message, level: 'blocking' });
        }
      }
      corpusFile.value = '';
    },
  });

  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  };
  const save = () => {
    try {
      localStorage.setItem(key, ta.value);
    } catch {}
  };
  const thread = () => S().threads[threadId];
  const busyOne = () =>
    sessionsOf(threadId)
      .filter(busy)
      .sort((a, _b) => (a.id === thread()?.lastSpeaker ? -1 : 1))[0];

  async function addFiles(files) {
    for (const f of files) {
      const chip = { kind: 'file', name: f.name, size: f.size, type: f.type, uploading: true };
      attachments.push(chip);
      paintAtt();
      try {
        Object.assign(chip, { fileId: (await uploadFile(f)).id, uploading: false });
      } catch (e) {
        attachments = attachments.filter((x) => x !== chip);
        toast({ title: `Couldn’t attach ${f.name}`, text: e.message, level: 'blocking' });
      }
      paintAtt();
    }
  }
  function paintAtt() {
    att.replaceChildren(
      ...attachments.map((a) =>
        h(
          'span.att',
          h('span.thumb', icon(a.kind === 'project-file' ? 'folder' : /^image\//.test(a.type ?? '') ? 'image' : 'file', 'i-sm')),
          a.kind === 'project-file' ? a.path : a.name,
          h(
            'span.dim',
            a.uploading
              ? ' · uploading…'
              : a.kind === 'project-file'
                ? ' · from the project folder'
                : a.size
                  ? ` · ${a.size > 1e6 ? (a.size / 1e6).toFixed(1) + ' MB' : Math.ceil(a.size / 1000) + ' KB'}`
                  : '',
          ),
          h(
            'button.btn.icon.sm.ghost',
            {
              type: 'button',
              'aria-label': `Remove ${a.name ?? a.path}`,
              onclick: () => {
                attachments = attachments.filter((x) => x !== a);
                paintAtt();
              },
            },
            icon('x', 'i-sm'),
          ),
        ),
      ),
    );
  }

  function plusMenu(anchor) {
    const t = thread();
    const last = S().sessions[t?.lastSpeaker] ?? sessionsOf(threadId)[0];
    openMenu(
      anchor,
      [
        { heading: 'Add a file' },
        { label: 'Upload from computer', desc: 'Or drop files anywhere in the conversation', icon: 'upload', run: () => file.click() },
        {
          label: 'From the project folder',
          desc: S().projects[t?.projectId]?.folder ?? '',
          icon: 'folder',
          run: () =>
            openFolderPicker(t.projectId, (path) => {
              attachments.push({ kind: 'project-file', path });
              paintAtt();
              focusComposer();
            }),
        },
        { label: 'Add to the corpus', desc: 'Index a text file for search', icon: 'books', run: () => corpusFile.click() },
        'hr',
        { heading: 'New agent' },
        { label: 'From a boilerplate', desc: 'Researcher, Critic, Indexer, or one you saved', icon: 'agent', run: () => openNewAgent({ threadId }) },
        ...((client.config.adapters ?? []).includes('claude-code')
          ? [{ label: 'Attach a Claude Code session', desc: 'One you started in a terminal', icon: 'link', run: () => openAttachSession(t?.projectId) }]
          : []),
        ...(last
          ? [
              {
                label: 'Recommend one',
                desc: `@${last.handle} drafts a teammate for this conversation`,
                icon: 'spark',
                run: () => sendMessage(threadId, `@${last.handle} please recommend a teammate for this conversation.`),
              },
            ]
          : []),
      ],
      { placement: 'above', label: 'Add' },
    );
  }

  async function submit(sendNow = false) {
    const text = ta.value.trim();
    if (attachments.some((a) => a.uploading)) {
      toast({ title: 'Still uploading', text: 'Send once the files finish uploading.' });
      return;
    }
    if (!text && !attachments.length) return;
    const ok = await sendMessage(
      threadId,
      text,
      attachments.map(({ uploading, ...a }) => a),
      { sendNow },
    );
    if (ok) {
      ta.value = '';
      attachments = [];
      paintAtt();
      save();
      autosize();
    }
  }

  // @-mention autocomplete
  function updateMention() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|[\s(])@([A-Za-z0-9_-]*)$/);
    if (!m) {
      mention = null;
      paintMention();
      return;
    }
    mention = { start: upto.length - m[2].length - 1, query: m[2].toLowerCase(), index: mention?.query === m[2].toLowerCase() ? mention.index : 0 };
    paintMention();
  }
  function candidates() {
    const members = new Set(sessionsOf(threadId).map((x) => x.personaId));
    return Object.values(S().personas)
      .filter((p) => !p.retired && p.handle.toLowerCase().startsWith(mention.query))
      .sort((a, b) => members.has(b.id) - members.has(a.id) || a.handle.localeCompare(b.handle))
      .slice(0, 6)
      .map((p) => ({ p, se: sessionsOf(threadId).find((x) => x.personaId === p.id) }));
  }
  function paintMention() {
    menuBox.replaceChildren();
    ta.removeAttribute('aria-activedescendant');
    if (!mention) {
      ta.removeAttribute('aria-controls');
      return;
    }
    const list = candidates();
    if (!list.length) return;
    mention.index = Math.min(mention.index, list.length - 1);
    const box = h(
      'div.menu.mention-menu',
      { role: 'listbox', id: 'mention-list', 'aria-label': 'Agents' },
      h('div.label', 'Wake an agent'),
      list.map(({ p, se }, i) => {
        const ring = se ? ringFor(se, 'sm') : h('pb-ring', { name: `@${p.handle}`, state: 'idle', ctx: '0', size: 'sm' });
        return h(
          'div.mi',
          {
            role: 'option',
            id: `mention-${i}`,
            'aria-selected': String(i === mention.index),
            class: i === mention.index ? 'active' : '',
            onmousedown: (e) => {
              e.preventDefault();
              insertMention(p.handle);
            },
          },
          ring,
          h(
            'span.grow',
            `@${p.handle}`,
            h('span.d', se?.archived ? 'Archived · restore it to wake it' : se ? `Here · ${stateWord(se.state).toLowerCase()}` : 'Not here · joins when woken'),
          ),
          i === mention.index ? h('span.k', 'Enter') : null,
        );
      }),
    );
    menuBox.append(box);
    // A textarea can’t be a combobox; the active option is announced through aria-activedescendant.
    ta.setAttribute('aria-controls', 'mention-list');
    ta.setAttribute('aria-activedescendant', `mention-${mention.index}`);
  }
  function insertMention(handle) {
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${handle} ${after}`;
    const pos = before.length + handle.length + 2;
    ta.setSelectionRange(pos, pos);
    mention = null;
    paintMention();
    save();
    ta.focus();
  }

  ta.addEventListener('input', () => {
    autosize();
    save();
    updateMention();
  });
  ta.addEventListener('click', updateMention);
  ta.addEventListener('blur', () =>
    setTimeout(() => {
      mention = null;
      paintMention();
    }, 120),
  );
  ta.addEventListener('keydown', (e) => {
    if (mention && candidates().length) {
      const n = candidates().length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mention.index = (mention.index + 1) % n;
        paintMention();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mention.index = (mention.index - 1 + n) % n;
        paintMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(candidates()[mention.index].p.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        mention = null;
        paintMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  ta.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (files.length) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name ? f : new File([f], `Pasted image ${i + 1}.png`, { type: f.type }))));
    } else if (text.length > 2000) {
      e.preventDefault();
      addFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })]);
      say('Long pasted text was attached as a file.');
    }
  });

  const el = h('div.composer', h('div.col', status, queue, menuBox, att, h('div.composer-box', plus, ta, action), hint, file, corpusFile));

  // Drop files anywhere on the thread
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  };
  const onDragOver = (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  };
  if (!side) {
    addEventListener('drop', onDrop);
    addEventListener('dragover', onDragOver);
  }

  function paint() {
    const t = thread();
    if (!t) return;
    const b = busyOne();
    action.replaceChildren();
    action.className = b ? 'btn stop' : 'btn send';
    action.textContent = b ? 'Stop' : 'Send';
    action.onclick = b
      ? () =>
          api(`/api/sessions/${b.id}/stop`, {})
            .then(() => say(`Stopped @${b.handle}.`))
            .catch((e) => toast({ title: 'Couldn’t stop', text: e.message }))
      : () => submit();
    action.setAttribute('aria-label', b ? `Stop @${b.handle}’s reply` : 'Send');
    const last = S().sessions[t.lastSpeaker];
    const members = sessionsOf(threadId).filter((x) => !x.archived);
    // Every agent here is archived: the conversation is read-only until you restore one.
    const archived = !topic && !side && !members.length ? sessionsOf(threadId) : [];
    ta.disabled = archived.length > 0;
    action.disabled = archived.length > 0;
    ta.placeholder = topic
      ? 'Reply in thread'
      : side
        ? 'Join this side thread…'
        : `${members.length > 1 ? 'Reply to' : 'Message'} @${(last ?? members[0])?.handle ?? 'an agent'}`;
    syncList(
      queue,
      t.queue ?? [],
      (q) => q.id,
      (q) => queuedRow(q),
      (node, q) => {
        if (node.dataset.editing) return; // keep an inline edit open while the agent works
        const fresh = queuedRow(q);
        node.replaceChildren(...fresh.childNodes);
      },
    );
    for (const m of outbox.filter((x) => x.threadId === threadId))
      queue.append(h('div.queued', icon('clock', 'dim'), h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), m.text)));
    const offline = client.connection !== 'open';
    fill(
      status,
      archived.length
        ? h(
            'div.sys',
            { style: { marginBottom: '6px' } },
            h(
              'span.pill',
              { role: 'status' },
              `Archived: read-only. `,
              archived.map((se) =>
                h(
                  'button.btn.sm',
                  {
                    type: 'button',
                    onclick: () => api(`/api/sessions/${se.id}/restore`, {}).catch((e) => toast({ title: 'Couldn’t restore', text: e.message })),
                  },
                  `Restore @${se.handle}`,
                ),
              ),
            ),
          )
        : offline
          ? h(
              'div.sys',
              { style: { marginBottom: '6px' } },
              h(
                'span.pill',
                { role: 'status', style: { borderColor: 'var(--accent)' } },
                h('span.g.g-running', { 'aria-hidden': 'true' }),
                h('b', 'Reconnecting…'),
                ` attempt ${client.attempts} · nothing is lost; replies pick up where they stopped`,
              ),
            )
          : '',
    );
    fill(
      hint,
      offline
        ? h('span', 'You’re offline. Messages you send now go out when the connection is back.')
        : topic
          ? h('span', 'Replies stay in this thread. @ brings in another agent from the conversation.')
          : side
            ? h('span', 'Anything you send here adds you to this side thread.')
            : [
                members.length > 1 && last ? h('span', 'Replying to ', h('b', `@${last.handle}`), ' (last speaker)') : null,
                h('span', 'Enter to send · Shift+Enter for a new line'),
                h('span.hide-sm', '@ to wake an agent · + to add a file or an agent'),
              ],
    );
  }
  function queuedRow(q) {
    const names = q.sessionIds
      .map((id) => S().sessions[id]?.handle)
      .filter(Boolean)
      .map((x) => `@${x}`)
      .join(', ');
    const text = h('span.q-text', h('span.small.dim', `Queued · sends when ${names} finishes`), h('br'), q.text);
    const row = h(
      'div.queued',
      icon('clock', 'dim'),
      text,
      h(
        'button.btn.sm',
        {
          type: 'button',
          onclick: () => api(`/api/threads/${threadId}/queue/${q.id}/send`, {}).catch((e) => toast({ title: 'Couldn’t send now', text: e.message })),
        },
        'Send now',
      ),
      h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          onclick: () => {
            // The row may have been refreshed in place, so mark the node it’s in now, not the one built here.
            const live = text.closest('.queued');
            const done = () => {
              delete live.dataset.editing;
              paint();
            };
            const input = h('input.input', {
              value: q.text,
              'aria-label': 'Edit the queued message',
              onkeydown: (e) => {
                if (e.key === 'Enter') saveEdit();
                if (e.key === 'Escape') done();
              },
            });
            const saveEdit = () =>
              api(`/api/threads/${threadId}/queue/${q.id}`, { text: input.value }, 'PATCH')
                .then(done)
                .catch((e) => toast({ title: 'Couldn’t edit', text: e.message }));
            live.dataset.editing = '1';
            text.replaceChildren(input, h('button.btn.sm', { type: 'button', onclick: saveEdit }, 'Save'));
            input.focus();
          },
        },
        'Edit',
      ),
      h(
        'button.btn.sm.ghost',
        { type: 'button', 'aria-label': 'Remove the queued message', onclick: () => api(`/api/threads/${threadId}/queue/${q.id}`, undefined, 'DELETE') },
        icon('x', 'i-sm'),
      ),
    );
    return row;
  }
  paint();
  autosize();
  const off = client.on((ch) => {
    if (['thread', 'session', 'connection', 'outbox', 'load'].includes(ch.type)) paint();
  });
  return {
    el,
    focus: () => ta.focus(),
    destroy() {
      off();
      removeEventListener('drop', onDrop);
      removeEventListener('dragover', onDragOver);
    },
  };
}

/**
 * The panel beside a conversation. It holds a topic thread (yours, forked from a message, with Summarize back)
 * or a side thread between agents (which you can join by typing).
 */
export function mountSidePanel(parentId, sideId) {
  const side = S().threads[sideId];
  if (!side) return null;
  const topic = side.kind === 'topic';
  const parent = S().threads[parentId];
  const tr = mountTranscript(sideId, { inPanel: true });
  const comp = mountComposer(sideId, { side: true });
  const root = topic ? itemsOf(parentId).find((x) => x.id === side.rootItemId) : null;
  const agents = sessionsOf(sideId).filter((x) => !x.archived);
  const body = h('div.sp-body', topic ? threadRoot(root, agents) : null, tr.el);
  const summarize = topic
    ? h(
        'button.btn.sm',
        {
          type: 'button',
          disabled: !agents.length,
          title: 'Ask the thread’s agent for a short summary, and post it in the conversation',
          onclick: () =>
            api(`/api/threads/${sideId}/summarize`, {})
              .then(() => toast({ title: 'Summary requested', text: `It will appear in ${parent?.title ?? 'the conversation'} when it’s written.` }))
              .catch((e) => toast({ title: 'Couldn’t ask for a summary', text: e.message, level: 'blocking' })),
        },
        'Summarize back',
      )
    : null;
  const el = h(
    'aside.sidepanel',
    { 'aria-labelledby': 'sp-title' },
    h(
      'div.sp-head',
      icon('thread', 'dim'),
      h(
        'div.grow',
        h('b', { id: 'sp-title' }, topic ? 'Thread' : side.title),
        h('div.small.dim', topic ? `in ${parent?.title ?? 'the conversation'}` : `Side thread from ${parent?.title ?? 'this conversation'}`),
      ),
      summarize,
      h(
        'button.btn.icon.sm.ghost',
        { type: 'button', 'aria-label': topic ? 'Close thread' : 'Close side thread', onclick: () => navigate(`#/t/${parentId}`) },
        icon('x'),
      ),
    ),
    body,
    h('div.sp-foot', comp.el),
  );
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });
  return {
    el,
    destroy() {
      tr.destroy();
      comp.destroy();
    },
  };
}

/** The message a topic thread branched from, at its top, and what the forked agent remembers. */
function threadRoot(root, agents) {
  if (!root) return null;
  const text = root.kind === 'block' ? `${root.block?.title ?? root.block?.type ?? 'A block'}${root.block?.type === 'app' ? ' (app)' : ''}` : (root.text ?? '');
  const one = agents.length === 1;
  // A long message is clamped to a few lines here; it’s all in the conversation beside it.
  const md = h('div.md.clamped', { html: trusted(renderMarkdown(text, { mentions: handles() })) });
  queueMicrotask(() => enhanceMarkdown(md));
  const more = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      'aria-expanded': 'false',
      onclick: (e) => {
        const open = md.classList.toggle('clamped') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.textContent = open ? 'Show less' : 'Show all';
      },
    },
    'Show all',
  );
  return h(
    'div.thread-root',
    h('span.label', root.kind === 'user' ? 'You' : `@${root.handle ?? ''}`),
    md,
    text.length > 280 || /\n\s*\n/.test(text) ? more : null,
    h(
      'p.small.dim',
      agents.length
        ? `${agents.map((x) => `@${x.handle}`).join(' and ')} here ${one ? 'is a branch of its' : 'are branches of their'} session at this message: ${one ? 'it remembers' : 'they remember'} the conversation up to here, and nothing in this thread reaches the conversation unless you send it.`
        : 'No agent is in this thread. @-mention one from the conversation to bring in a branch of its session.',
    ),
  );
}

export const _test = { renderItem, activityLabel };
