// The conversation view: transcript, composer, and the panel beside it for topic threads (yours, forked from a
// message) and side threads (between agents).

import { INLINE_TYPES } from '/shared/files.mjs';
import { renderMarkdown } from '/shared/markdown.mjs';
import { mockMarker } from './agent-facts.mjs';
import { agentsSection, subagentNow } from './agents.mjs';
import { enhanceMarkdown, renderAppItem, renderAppSendCard } from './apps.mjs';
import { renderBlock } from './blocks.mjs';
import { api, busy, client, hrefOf, itemsOf, sessionsAt, sessionsOf, sideSessionsOf, stopSession, threadLink, uploadFile } from './client.mjs';
import { $, ago, dayOf, fill, h, icon, plural, syncList, timeOf, trusted } from './dom.mjs';
import { openPermissions, openRunChoice } from './permissions.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { openAttachSession, openFolderPicker, openNewAgent, openRename } from './sheets.mjs';
import { sideActive, sideLine, sideSig } from './side-line.mjs';
import { announceStreaming, navigate, openMenu, openWork, paneHref, say, toast } from './ui.mjs';

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

// Where a transcript was scrolled, kept while the view is rebuilt around it (opening or closing the panel), so a
// rebuild doesn’t move you. Cleared once that rebuild has run.
const kept = new Map();

/** A live transcript for one thread. Returns { el, settle, scrollToEnd, setJump, destroy }. */
export function mountTranscript(threadId, { inPanel = false } = {}) {
  const el = h('div.transcript', { id: inPanel ? null : 'main', tabindex: '-1', 'aria-label': 'Conversation', dataset: { thread: threadId } });
  const nodes = new Map();
  const pending = new Set();
  let raf = 0;
  const was = kept.get(`${inPanel}:${threadId}`);
  let unseen = was?.unseen ?? 0;
  // Stuck: the view is on the newest message, and stays there through anything that changes the transcript’s
  // size (streaming, patches, apps growing, the panel, the window) until you scroll up yourself (#88). Otherwise
  // it stays on what you were reading: the anchor, a message and how far down the view it starts.
  let stuck = !was;
  let anchor = was?.anchor ?? null;
  let dead = false;
  // At the end of the transcript, one row per agent that’s thinking or calling tools: what it’s on right now,
  // and a glimpse of its thinking. It goes while the agent writes, since the reply itself shows then. It sits in
  // the message column, like the messages (#83).
  const working = h('div.working.col', { 'aria-hidden': 'true' });
  const paintWorking = () => {
    // The agents whose turn is here: a conversation’s, unless its turn is in a side thread, and in a side thread, any
    // session answering in it (#110).
    const busy = sessionsAt(threadId).filter(
      (se) => !se.archived && (se.state === 'think' || se.state === 'tool') && (!se.sideTurn || se.sideTurn.threadId === threadId),
    );
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

  const box = () => (inPanel ? el.parentElement : document.scrollingElement);
  const viewTop = (s) => (inPanel ? s.getBoundingClientRect().top : 0);
  const gapOf = (s) => s.scrollHeight - s.scrollTop - s.clientHeight;
  // At the bottom, give or take a pixel of rounding.
  const atEnd = (s) => gapOf(s) <= 2;
  // The pill floats just above the composer. It shows only while the end is further below than that, so what it
  // floats over is never the working rows or the end of the last message (#91).
  const PILL_ROOM = 48;
  let shown = -1;
  const showJump = (s) => {
    const n = s && gapOf(s) > PILL_ROOM ? unseen : 0;
    if (n !== shown) jump?.((shown = n));
  };
  // The anchor is the message across the middle of the view, where you read, not the first one in view: that one
  // usually starts above the view, and when a narrower column (the panel, a smaller window) rewraps it, everything
  // under it moves. A wide font rewraps it where macOS’s doesn’t (#88, seen on Linux in #162).
  const findAnchor = () => {
    const s = box();
    if (!s) return null;
    const top = viewTop(s);
    const mid = top + s.clientHeight / 2;
    let last = null;
    for (const n of el.children) {
      if (!(n instanceof HTMLElement && n.dataset.key)) continue;
      const r = n.getBoundingClientRect();
      if (r.bottom <= top) continue;
      last = { key: n.dataset.key, at: r.top - top };
      if (r.bottom > mid) return last;
    }
    return last;
  };
  const holdAnchor = () => {
    const s = box();
    const n = anchor && nodes.get(anchor.key);
    if (!s || !n?.isConnected) return;
    const d = n.getBoundingClientRect().top - viewTop(s) - anchor.at;
    if (Math.abs(d) >= 1) s.scrollTop += d;
  };
  const seen = () => {
    unseen = 0;
    showJump(null);
  };
  const scrollToEnd = (smooth = false) => {
    stuck = true;
    const s = box();
    if (s && smooth && !inPanel && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    else if (s) s.scrollTop = s.scrollHeight;
    seen();
  };
  // While stuck, what comes after the newest message shrinking (a working row going, a card getting shorter once
  // answered, the composer) would shorten the page and pull everything down, under your pointer, just as a card
  // that needs you arrives. Instead the transcript keeps its height, until the next message or a new width.
  let held = { end: 0, last: 0, width: 0 };
  const lastItem = () => {
    for (let n = el.lastElementChild; n; n = n.previousElementSibling) if (n instanceof HTMLElement && n.dataset.key) return n;
    return null;
  };
  const measure = (s) => ({
    end: s.scrollHeight,
    last: (lastItem()?.getBoundingClientRect().top ?? 0) - viewTop(s) + s.scrollTop,
    width: el.clientWidth,
  });
  const release = () => {
    if (el.style.minHeight) el.style.minHeight = '';
  };
  // After anything changes size: back to the bottom while stuck, else keep what you were reading in place.
  const follow = () => {
    const s = box();
    if (!s || dead) return;
    // You scrolled up in this frame, before its scroll event: that counts, so don’t pull you back.
    if (stuck && s.scrollTop < lastTop - 1 && !atEnd(s)) {
      stuck = false;
      anchor = findAnchor();
    }
    if (stuck) {
      const now = measure(s);
      if (now.width !== held.width) release();
      else if (now.end < held.end && Math.abs(now.last - held.last) < 1 && held.end > s.clientHeight)
        el.style.minHeight = `${el.getBoundingClientRect().height + held.end - now.end}px`;
      if (!atEnd(s)) s.scrollTop = s.scrollHeight;
      held = measure(s);
    } else holdAnchor();
    showJump(s);
  };
  // Only your own scrolling unsticks the view: content growing never scrolls, and the browser doesn’t anchor
  // (overflow-anchor is off), so the view moving up means you moved it, by wheel, keys or a drag, even over an app.
  let lastTop = 0;
  const onScroll = () => {
    const s = box();
    if (!s) return;
    if (atEnd(s)) {
      if (!stuck) held = measure(s);
      stuck = true;
    } else if (s.scrollTop < lastTop) stuck = false;
    // However you got near the end, there’s nothing unread below any more (#91).
    if (gapOf(s) <= PILL_ROOM) seen();
    lastTop = s.scrollTop;
    if (!stuck) anchor = findAnchor();
  };
  const sizes = new ResizeObserver(follow);
  let bound = null;
  const bind = () => {
    const s = box();
    if (bound || !s || !el.isConnected) return;
    bound = inPanel ? s : window;
    bound.addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', follow);
    sizes.observe(el);
    // What’s around it changing moves the end too: the composer, the panel’s height, the thread’s root above.
    if (el.parentElement) for (const n of [el.parentElement, ...el.parentElement.children]) if (n !== el) sizes.observe(n);
  };
  /** Once the transcript is on the page: to the newest message, or back where you were before a rebuild. */
  const settle = () => {
    // A rebuild can replace this transcript before the frame it was to settle in.
    if (dead) return;
    bind();
    const s = box();
    if (stuck) scrollToEnd();
    else holdAnchor();
    if (s) {
      showJump(s);
      held = measure(s);
    }
    lastTop = s?.scrollTop ?? 0;
  };
  let jump = null;
  const grew = () => {
    if (stuck) follow();
    else {
      unseen++;
      showJump(box());
    }
  };

  const off = client.on((ch) => {
    if (ch.type === 'load') {
      all();
      return;
    }
    const d = ch.data;
    if (ch.type === 'item.add' && d.threadId === threadId) {
      if (nodes.size === 0) el.replaceChildren();
      // A new message takes the place of any height held below the last one.
      release();
      const list = itemsOf(threadId);
      const n = render(d.item, list[list.length - 2]);
      nodes.set(d.item.id, n);
      el.append(n);
      paintWorking();
      grew();
    } else if (ch.type === 'item.move' && d.threadId === threadId) {
      // An update brought an app or a block to the newest point (#49, #92). Its stub takes its old place, the same
      // height a line takes, and what you were reading stays put: if that was the item, the stub holds its place.
      const list = itemsOf(threadId);
      const at = list.findIndex((x) => x.id === d.stub.id);
      const stub = render(d.stub, list[at - 1]);
      nodes.get(d.id)?.replaceWith(stub);
      nodes.set(d.stub.id, stub);
      if (anchor?.key === d.id) anchor = { key: d.stub.id, at: Math.max(0, anchor.at) };
      // The message after it now follows the stub, so whether it names its speaker can change.
      if (list[at + 1] && list[at + 1].id !== d.id) rerender(list[at + 1].id);
      release();
      const n = render(list[list.length - 1], list[list.length - 2]);
      nodes.set(d.id, n);
      el.append(n);
      paintWorking();
      grew();
    } else if (ch.type === 'item.patch' && d.threadId === threadId) {
      rerender(d.id);
    } else if (ch.type === 'item.text' && d.threadId === threadId) {
      pending.add(d.id);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          for (const id of pending) updateText(id);
          pending.clear();
        });
    } else if (ch.type === 'glossary' && d.threadId === threadId) {
      for (const it of itemsOf(threadId)) if (it.kind === 'agent') updateText(it.id, true);
    } else if (ch.type === 'session') {
      el.querySelectorAll(`pb-ring[data-session="${CSS.escape(d.id)}"]`).forEach((r) => {
        ringFor(d, r.getAttribute('size'), r);
      });
      // An agent at work here may not be one of this thread’s own (#110): its turn is in it.
      paintWorking();
      for (const it of itemsOf(threadId))
        if (it.kind === 'sidelink' && nodes.get(it.id)?.dataset.sideSig !== sideSig(sideActive(it.sideThreadId))) rerender(it.id);
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
    settle,
    scrollToEnd,
    setJump(fn) {
      jump = fn;
    },
    destroy() {
      off();
      dead = true;
      if (!stuck && el.isConnected) {
        const key = `${inPanel}:${threadId}`;
        kept.set(key, { anchor: findAnchor() ?? anchor, unseen });
        queueMicrotask(() => kept.delete(key));
      }
      sizes.disconnect();
      bound?.removeEventListener('scroll', onScroll);
      removeEventListener('resize', follow);
    },
  };
}

function fillWorkRow(row, se) {
  ringFor(se, 'xs', row.querySelector('pb-ring'));
  const step = se.state === 'tool' && se.currentStep ? `: ${se.currentStep}` : '';
  fill(
    row.querySelector('.work-text'),
    h('div.work-line', h('b', `@${se.handle}`), h('span.dim', ` · ${stateWord(se.state).toLowerCase()}${step}`)),
    se.glimpse ? h('div.glimpse', se.glimpse) : null,
    // Each subagent at work, in its own words when it has said something (#73): “reader: Now I’ll read paper 3…”.
    (se.subagents ?? []).map((x) => h('div.work-line.work-sub', h('span', `${x.name}: `), h('span.dim', subagentNow(x)))),
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
  return h('div.who', ring, h('b', `@${it.handle}`), mockMarker(se), state, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, ts);
};

// Under a message in a conversation: “Reply in thread”, or once a thread exists, “3 replies”. Under a message in a
// topic or side thread (#128): “Send to conversation”. The actions appear on hover and focus, and always on touch screens.
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
  } else if ((ctx.kind === 'topic' || ctx.kind === 'side') && (it.kind === 'agent' || it.kind === 'user') && it.text) {
    bar.append(
      it.sharedAt
        ? h('span.small.dim', icon('check', 'i-sm'), ' Sent to the conversation')
        : h(
            'button.btn.sm.ghost.reveal',
            {
              type: 'button',
              // Once: the button waits for its answer, and the reply then shows it was sent (#93).
              onclick: (e) => {
                const b = e.currentTarget;
                b.disabled = true;
                api(`/api/threads/${ctx.threadId}/items/${it.id}/share`, {})
                  .then(() => toast({ title: 'Sent to the conversation', text: 'Its agents read it at the start of their next turn.' }))
                  .catch((err) => {
                    b.disabled = false;
                    toast({ title: 'Couldn’t send it', text: err.message, level: 'blocking' });
                  });
              },
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
              stepTree(steps),
            )
          : null,
        jobRows(it, steps),
        // What the turn changed, ran and published, from the work ledger (#132), leading to it.
        it.work ? workChip(it, ctx) : null,
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
        // Named like any other block (#88). Only the agent that wrote an app can update it, so this is also who
        // made each version.
        return h('div.wide', showWho ? h('div.col', who(it)) : null, renderAppItem(it, ctx));
      }
      // revision: the one the person answered (#123); a card’s or table’s action doesn’t say.
      const act = async (action, values, revision) => {
        const r = await api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values, revision });
        focusComposer();
        return r;
      };
      const node = h('div.col.turn', showWho ? who(it) : null, renderBlock(it, { act, threadId: ctx.threadId }));
      if (it.valid && it.block.type === 'review' && it.block.format === 'app') node.dataset.appVersion = String(S().apps[it.block.appId]?.current ?? '');
      return node;
    }
    case 'voice':
      // An app’s summary is its own wording, so it shows beside your line as a quote from the app, never in your
      // voice (#51).
      return h(
        'div.col.turn.me',
        h('span.voice', icon('thread', 'i-sm'), it.text),
        it.quote ? h('span.app-says', 'The app’s summary: ', h('q', it.quote)) : null,
      );
    case 'shared':
      // A reply or a summary sent back from a topic or side thread, by you or by an agent you asked (#128). Its agents
      // read it at the start of their next turn.
      return h(
        'div.col.turn',
        h(
          'div.shared-card',
          h(
            'div.shared-head',
            icon('thread', 'i-sm'),
            h(
              'span.grow',
              it.summary ? 'Summary of the thread ' : 'From the thread ',
              h('b', `“${it.fromTitle}”`),
              it.agent ? ` · shared by @${it.handle} in a turn you started` : it.handle ? ` · @${it.handle}` : ' · you',
            ),
            S().threads[it.fromThreadId] ? h('a.small', { href: hrefOf(it.fromThreadId) }, 'Open thread') : null,
          ),
          h('div.md', { html: trusted(renderMarkdown(it.text, { mentions: handles() })) }),
        ),
      );
    case 'system':
      return systemLine(it, ctx);
    case 'sidelink':
      return sideLine(it, ctx);
    case 'hop':
      return hopBlock(it, ctx);
    case 'permission':
      return permissionBlock(it, ctx);
    case 'command':
      return commandBlock(it, ctx);
    case 'denial':
      return denialBlock(it, ctx);
    case 'toolask':
      return toolAskBlock(it, ctx);
    case 'appsend':
      return renderAppSendCard(it, ctx);
    case 'moved':
      return movedLine(it, ctx);
    case 'proposal':
      return proposalBlock(it, ctx, showWho);
    default:
      return h('div.col.small.dim', `Unknown item “${it.kind}”.`);
  }
}

/** A turn’s line from the work ledger (#132), which opens the conversation’s Work in the right pane, at that turn. */
function workChip(it, ctx) {
  const t = client.state.threads[ctx.threadId];
  const conv = (t?.kind === 'side' || t?.kind === 'topic') && t.parentId ? t.parentId : ctx.threadId;
  return h(
    'a.work-chip',
    {
      href: paneHref(conv, { work: true, turn: it.turnId }),
      'aria-label': `This turn’s work: ${it.work}`,
      // Beside the thread that’s open, if any: the address is worked out when you choose it.
      onclick: (e) => {
        e.preventDefault();
        openWork(conv, { turn: it.turnId });
      },
    },
    icon('file', 'i-sm'),
    it.work,
  );
}

function failureText(msg = 'This reply didn’t finish.') {
  const m = msg.match(/^(.*?[.!?])\s+([\s\S]*)$/);
  return m ? [h('b', m[1]), ' ', m[2]] : [h('b', msg)];
}

function activityLabel(all) {
  const steps = all.filter((s) => s.kind !== 'thought' && s.kind !== 'said');
  const thoughts = all.filter((s) => s.kind === 'thought').length;
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

/**
 * The activity list as a tree (#73): what a subagent did, said and thought nests under the step that started it, at
 * any depth, so a refused or failed step points at the subagent that took it.
 */
function stepTree(steps) {
  const ids = new Set(steps.map((s) => s.id));
  /** @type {Map<string, any[]>} */
  const kids = new Map();
  for (const s of steps) if (s.parent && s.parent !== s.id && ids.has(s.parent)) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const seen = new Set();
  const row = (s) => {
    seen.add(s);
    const li = stepRow(s);
    const under = (kids.get(s.id) ?? []).filter((x) => !seen.has(x));
    if (under.length) li.append(h('ul.steps', under.map(row)));
    return li;
  };
  const top = steps.filter((s) => !s.parent || s.parent === s.id || !ids.has(s.parent)).map(row);
  // Any a bad parent left out (a loop) is listed at the top, rather than gone.
  for (const s of steps) if (!seen.has(s)) top.push(row(s));
  return h('ul.steps', top);
}

// One step in an agent’s activity list: a tool call (the agent’s or a subagent’s), a thought, or a subagent’s
// narration, which open to their whole text. A failed step says why; a refused one says why too when its backend does
// (the Kiro and Antigravity CLIs refuse headless, with no card: #152), and otherwise points to its card. A subagent’s
// step says what it returned once it has (#73).
const GLYPH = { running: 'running', failed: 'failed', denied: 'failed', done: 'done', stopped: 'stalled' };
function stepRow(s) {
  const dur = h('span.dur', s.ms ? `${(s.ms / 1000).toFixed(1)} s` : '');
  // A subagent’s thought or narration is labeled with its name: it’s its own, never the agent’s (#73).
  const who = s.who ? h('span.step-who', `${s.who}:`) : null;
  if (s.kind === 'thought' || s.kind === 'said')
    return h(
      `li.${s.kind}`,
      // Narration is read as “name: what it said”, so its glyph isn’t read too.
      s.kind === 'said' ? h('span.g.g-said', { 'aria-hidden': 'true' }) : h('span.g.g-thought', { role: 'img', 'aria-label': 'thought' }),
      s.detail && s.detail !== s.label
        ? h('details.step-text', h('summary', who ? [who, ' '] : null, s.label), h('p', s.detail))
        : h('span.step-text', who ? [who, ' '] : null, h('span', s.label)),
      dur,
    );
  const note =
    s.state === 'denied'
      ? s.detail || 'Refused: see the card below.'
      : s.state === 'failed'
        ? s.detail
        : s.state === 'stopped'
          ? `Stopped${s.detail ? `: ${s.detail}` : ''}`
          : s.job && s.state === 'running'
            ? s.detail || 'Running in the background'
            : s.kind === 'agent'
              ? s.detail || null
              : null;
  return h(
    'li',
    { class: s.state === 'denied' ? 'denied' : '' },
    h(`span.g.g-${GLYPH[s.state] ?? 'done'}`, { role: 'img', 'aria-label': s.state === 'denied' ? 'refused' : s.state }),
    h('span.step-text', s.who ? h('span.step-who', `${s.who} ·`) : null, h('span.mono', s.label), note ? h('span.step-note', note) : null),
    dur,
  );
}

/**
 * The background jobs a reply started that are still running (#129), outside the folded steps so you can see them, each
 * with its own Stop. The call returned at once, so without this the step would read done while the job runs on.
 */
function jobRows(it, steps) {
  const jobs = steps.filter((s) => s.job && s.state === 'running');
  if (!jobs.length || !it.sessionId) return null;
  return h(
    'ul.bg-jobs',
    { 'aria-label': 'Background jobs' },
    jobs.map((s) =>
      h(
        'li',
        h('span.g.g-running', { role: 'img', 'aria-label': 'running' }),
        // What Postbox kept running for it, when it couldn’t tell which process was the job (#164).
        h('span.grow', h('span.dim', 'Background job · '), h('span.mono', s.label), s.detail ? h('span.job-note', s.detail) : null),
        h(
          'button.btn.sm',
          {
            type: 'button',
            'aria-label': `Stop the background job “${s.label}”`,
            onclick: (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              api(`/api/sessions/${it.sessionId}/jobs/${encodeURIComponent(s.job)}/stop`, {})
                .then(() => say(`Stopped the background job “${s.label}”.`))
                .catch((err) => {
                  b.disabled = false;
                  toast({ title: 'Couldn’t stop the job', text: err.message, level: 'blocking' });
                });
            },
          },
          'Stop',
        ),
      ),
    ),
  );
}

const fileSize = (size) => (size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);

/**
 * An attachment on a sent message. Images the server shows inline (INLINE_TYPES) get a thumbnail that opens
 * the full image in a new tab; everything else, an SVG included, is a file chip that downloads.
 */
function attChip(a) {
  const label = a.kind === 'project-file' ? a.path : a.name;
  const href = a.fileId ? `/api/files/${encodeURIComponent(a.fileId)}` : null;
  if (href && INLINE_TYPES.has(a.type)) {
    // One link: the image’s alt text and the size are its name, so it reads as “photo.png · 318 KB”.
    return h(
      'a.att-image',
      { href, target: '_blank', rel: 'noopener' },
      h('img', { src: href, alt: a.name, width: '160', height: '120', loading: 'lazy', decoding: 'async' }),
      h('span.att-cap', h('span.att-name', { 'aria-hidden': 'true' }, a.name), a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null),
    );
  }
  return h(
    'span.att',
    h('span.thumb', icon(a.kind === 'project-file' ? 'folder' : /^image\//.test(a.type ?? '') ? 'image' : 'file', 'i-sm')),
    href ? h('a', { href, style: { color: 'inherit' } }, label) : label,
    a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null,
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
          : [
              h('b', `@${it.from}`),
              ' woke ',
              h('b', `@${it.to}`),
              // It had no session here, so it joined the conversation to answer (#110).
              it.joined ? ' · joined the conversation' : '',
              it.n ? ` · agent wake ${it.n} of ${it.limit ?? 3}` : '',
            ],
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
    case 'dataset':
      // An agent loaded a dataset into the corpus (#47): searched only when a search names it.
      return h(
        'div.col.sys-line',
        icon('books', 'i-sm'),
        h('b', `@${it.handle}`),
        ' loaded the dataset ',
        h('span.mono', it.dataset),
        ` · ${plural(it.records, 'record')}, searched only when named`,
      );
    case 'joined':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' joined');
    case 'left':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' left (its session was deleted)');
    default:
      return h('div.col.sys-line', it.text ?? '');
  }
}

/**
 * Where an app or a block was before an update brought it to the newest point (#49, #92): one line that leads to it.
 * There’s one live copy, below; this only says it moved.
 */
function movedLine(it, ctx) {
  const live = itemsOf(ctx.threadId).some((x) => x.id === it.itemId);
  return h(
    'div.col.sys-line.moved',
    icon('down', 'i-sm'),
    h('span', h('b', it.title), it.what === 'app' ? ` · updated to v${it.v} below` : ' · asked again below'),
    live
      ? h(
          'button.btn.sm.ghost',
          {
            type: 'button',
            // The name starts with the words on the button, so saying what you see presses it (WCAG 2.5.3).
            'aria-label': `Go to it: ${it.title}`,
            onclick: (e) => {
              const box = /** @type {HTMLElement} */ (e.currentTarget).closest('.transcript');
              const node = box?.querySelector(`:scope > [data-key="${CSS.escape(it.itemId)}"]`);
              if (!(node instanceof HTMLElement)) return;
              node.scrollIntoView({ block: 'center' });
              (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus({ preventScroll: true });
            },
          },
          'Go to it',
        )
      : null,
  );
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

/**
 * A `!command` you ran (#67): the command line, where it ran, its output as it streams (the last 64 KB, saying when
 * earlier output was cut), Stop while it runs, then the exit code and how long it took. The agents read it on their
 * next turn.
 */
function commandBlock(it, ctx) {
  const running = it.status === 'running';
  const secs = it.ms != null ? `${(it.ms / 1000).toFixed(it.ms < 10000 ? 1 : 0)} s` : '';
  const ended =
    it.status === 'done'
      ? [icon('check', 'i-sm'), `Exit 0 · ${secs}`]
      : it.status === 'stopped'
        ? [icon('x', 'i-sm'), it.error ? `Stopped: ${it.error}` : `Stopped by you${secs ? ` · ${secs}` : ''}`]
        : it.error
          ? [icon('warn', 'i-sm'), `Couldn’t run: ${it.error}`]
          : [icon('warn', 'i-sm'), `Exit ${it.exitCode ?? it.signal ?? '?'} · ${secs}`];
  const titleId = `cmd-${it.id}`;
  const out = it.text ? h('pre.md-code.cmd-out', { tabindex: '0', 'aria-label': `Output of ${it.command}` }, h('code', it.text)) : null;
  // While it runs, the newest output is in view: the item is drawn again as output arrives.
  if (out && running) requestAnimationFrame(() => out.scrollTo({ top: out.scrollHeight }));
  return h(
    'div.col.block.cmd-block',
    { role: 'group', 'aria-labelledby': titleId, class: it.status === 'failed' ? 'cmd-failed' : '' },
    h('div.block-head', h('code.title.grow.cmd-line', { id: titleId }, `! ${it.command}`), h('span.kind', `Command · ${it.cwd}`)),
    h(
      'div.block-body',
      it.cut ? h('p.small.dim', 'Earlier output was cut: this is the last 64 KB.') : null,
      it.paused && running ? h('p.small.dim', 'It’s still printing. The end of its output shows here when it finishes.') : null,
      out ?? h('p.small.dim', running ? 'No output yet.' : 'No output.'),
    ),
    h(
      'div.block-foot',
      running
        ? [
            h('span.small', h('span.g.g-running', { 'aria-hidden': 'true' }), ' Running'),
            h(
              'button.btn.sm',
              {
                type: 'button',
                onclick: () => api(`/api/threads/${ctx.threadId}/shell/${it.id}/stop`, {}).catch((e) => toast({ title: 'Couldn’t stop it', text: e.message })),
              },
              'Stop',
            ),
          ]
        : h('span.answered-note.cmd-exit', { role: 'status' }, ...ended),
      h('span.small.dim.grow.cmd-note', 'The agents read this on their next turn.'),
    ),
  );
}

// An agent in “ask” mode waits here before a risky tool call. It isn’t a catalog block: Postbox draws it,
// and your answer goes straight back to the waiting tool call rather than to the agent as a message.
const PERMISSION_DONE = {
  allowed: 'Allowed',
  'allowed-always': 'Always allowed',
  'allowed-edited': 'Allowed with your edit',
  denied: 'Not allowed',
  expired: 'Expired: the turn ended before you answered',
};
/**
 * The answers (#66, #10): Allow; Always allow, with the rule and where it’s saved shown in words first; Edit, which
 * changes the command (or the input’s JSON) and allows that; Don’t allow, with an optional reason the agent reads.
 */
function permissionBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action, values = {}) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values })
      .then(focusComposer)
      .catch((e) => {
        toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });
        throw e;
      });
  const titleId = `pm-${it.id}`;
  const by = it.who ? `@${it.handle}’s subagent (${it.who})` : `@${it.handle}`;
  const bash = it.tool === 'Bash';
  // Edit and Don’t allow open a small form in the card; only one at a time.
  const form = h('div.perm-form');
  const foot = h('div.block-foot');
  const buttons = () => [
    h('button.btn', { type: 'button', onclick: () => act('allow') }, 'Allow'),
    it.always ? h('button.btn', { type: 'button', 'aria-describedby': `${titleId}-always`, onclick: () => act('always') }, 'Always allow') : null,
    // Edit needs the call’s whole input: one too large to keep here can only be allowed as it is.
    it.input ? h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: (e) => showEdit(e.currentTarget) }, 'Edit…') : null,
    h('button.btn', { type: 'button', 'aria-expanded': 'false', onclick: (e) => showDeny(e.currentTarget) }, 'Don’t allow…'),
    h('span.small.dim', `${by} is waiting for you.`),
  ];
  const close = (back) => {
    form.replaceChildren();
    for (const b of foot.querySelectorAll('[aria-expanded]')) b.setAttribute('aria-expanded', 'false');
    back?.focus();
  };
  function showEdit(button) {
    close();
    button.setAttribute('aria-expanded', 'true');
    const start = bash ? String(it.input.command ?? '') : JSON.stringify(it.input, null, 2);
    const id = `${titleId}-edit`;
    const err = h('p.err', { id: `${id}-err`, hidden: true });
    const box = h(
      `textarea.textarea.mono`,
      { id, rows: String(Math.min(12, start.split('\n').length + 1)), spellcheck: 'false', 'aria-describedby': `${id}-err` },
      start,
    );
    const submit = () => {
      let values;
      if (bash) values = { command: box.value };
      else {
        // Checked here first, so a typo is caught before it reaches the agent; the server checks it again.
        try {
          const v = JSON.parse(box.value);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('It has to be a JSON object, like the one it started from.');
        } catch (e) {
          err.hidden = false;
          err.textContent = `This doesn’t parse: ${e.message}`;
          box.classList.add('invalid');
          box.focus();
          return;
        }
        values = { input: box.value };
      }
      act('edit', values).catch(() => box.focus());
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(button);
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    form.replaceChildren(
      h('label.label', { for: id }, bash ? 'The command to run instead' : 'The input to use instead (JSON)'),
      box,
      err,
      h(
        'div.row-flex',
        h('button.btn.send', { type: 'button', onclick: submit }, 'Allow with this edit'),
        h('button.btn.ghost', { type: 'button', onclick: () => close(button) }, 'Cancel'),
      ),
    );
    box.focus();
  }
  function showDeny(button) {
    close();
    button.setAttribute('aria-expanded', 'true');
    const id = `${titleId}-why`;
    const why = h('input.input', { id, placeholder: 'Optional: what to do instead', maxlength: '1000' });
    const submit = () => act('deny', { reason: why.value }).catch(() => why.focus());
    why.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close(button);
      }
    });
    form.replaceChildren(
      h('label.label', { for: id }, `Why not? @${it.handle} reads this`),
      why,
      h(
        'div.row-flex',
        h('button.btn.send', { type: 'button', onclick: submit }, 'Don’t allow'),
        h('button.btn.ghost', { type: 'button', onclick: () => close(button) }, 'Cancel'),
      ),
    );
    why.focus();
  }
  if (open) foot.append(...buttons().filter(Boolean));
  const done = it.status.startsWith('allowed');
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `Let ${by} ${it.summary}?`),
      h('span.kind', 'Permission · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      // A write outside Postbox (#112): say so, and show its draft as it will read, before anything exists outside.
      it.outside
        ? h(
            'p.small',
            h('b', 'This writes outside Postbox'),
            it.where ? [', to ', h('b', it.where.server), it.where.target ? ` (${it.where.target.what} “${it.where.target.name}”)` : ''] : '',
            '.',
            open ? ' Nothing is created, sent or changed until you allow it.' : '',
          )
        : null,
      it.draft
        ? h(
            'div.col.perm-draft',
            { role: 'group', 'aria-label': 'The draft', tabindex: '0' },
            h('span.label', `The draft, from ${it.draft.field}`),
            h('div.md', { html: trusted(renderMarkdown(it.draft.text)) }),
          )
        : null,
      // The whole command, wrapped: you decide on what you can see.
      it.detail ? h('pre.md-code.perm-detail', h('code', it.detail)) : null,
      // What Always allow saves, in words, before you click it.
      open && it.always
        ? h(
            'div.small.perm-always',
            { id: `${titleId}-always` },
            it.always.lines.map((l) => h('p', l.rule ? ['Always allow ', h('code', l.rule), l.text.slice(`Always allow ${l.rule}`.length)] : l.text)),
            it.always.moved ? h('p.dim', it.always.moved) : null,
            // What Always allow gives up on a write outside Postbox (#112): the draft step, for that tool.
            it.outside ? h('p', `From now on ${by} can use `, h('code', it.tool), ' without showing you a draft.') : null,
          )
        : null,
      open ? form : null,
      !open
        ? h(
            'span.answered-note',
            icon(done ? 'check' : 'x', 'i-sm'),
            PERMISSION_DONE[it.status] ?? it.status,
            it.status === 'allowed-always' && it.always ? ` (${it.always.lines.map((l) => l.rule ?? l.text).join(', ')})` : '',
          )
        : null,
      !open && it.edited ? h('pre.md-code.perm-detail', { 'aria-label': 'What ran instead' }, h('code', it.edited)) : null,
      !open && it.reason ? h('p.small', h('b', 'Your reason: '), it.reason) : null,
    ),
    open ? foot : null,
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
      h('span.kind', 'Refused · ', h('span.tool-name', it.tool)),
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

// An agent asks for a tool the person turned off for it (#104). The card says what turning it on does before the click:
// it changes the persona, in every conversation, and the permission mode still decides each call.
function toolAskBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `ta-${it.id}`;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `@${it.handle} asks you to turn on “${it.label}”`),
      h('span.kind', 'Turned off · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      h('p', `It’s turned off for @${it.handle} in Postbox, so it can’t use it here.`),
      it.why ? h('p.small', h('b', `@${it.handle}: `), it.why) : null,
      open
        ? h(
            'p.small.dim',
            `Turning it on ticks it in @${it.handle}’s Tools, in every conversation, from its next turn. Its permission mode still decides each call.`,
          )
        : h('span.answered-note', icon(it.status === 'on' ? 'check' : 'x', 'i-sm'), it.status === 'on' ? 'Turned on.' : 'Kept off.'),
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('on') }, `Turn on for @${it.handle}`),
          h('button.btn.ghost', { type: 'button', onclick: () => act('off') }, 'Keep it off'),
        )
      : null,
  );
}

const BACKEND_NAMES = {
  'claude-code': 'Claude Code',
  'agent-sdk': 'Agent SDK',
  'kiro-cli': 'Kiro CLI',
  'antigravity-cli': 'Antigravity CLI',
  codex: 'Codex',
  mock: 'Mock agent',
};

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
  // / and ! (#67) live in a conversation’s own composer, not in a thread panel’s.
  const commands = !side && !topic;
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
  // The / menu (#67): Postbox’s commands and the agents’ skills, by typing / or with this button. Only in a
  // conversation’s own composer, where ! runs commands too.
  let slash = null; // { query, index }
  let slashTarget = null; // the agent skill or command picked: { sessionId, handle, name, argumentHint }
  const commandsButton = !commands
    ? null
    : h(
        'button.btn.icon.ghost.cmd-button',
        {
          type: 'button',
          'aria-label': 'Commands',
          title: 'Commands (/)',
          'aria-haspopup': 'listbox',
          onclick: () => {
            if (!ta.value.startsWith('/')) ta.value = `/${ta.value.trimStart()}`;
            ta.focus();
            ta.setSelectionRange(1, 1);
            updateSlash();
            autosize();
          },
        },
        h('span.cmd-glyph', { 'aria-hidden': 'true' }, '/'),
      );
  const action = h('button.btn', { type: 'button' });
  const att = h('div.attachments', { role: 'group', 'aria-label': 'Attachments' });
  const queue = h('div.outbox');
  // Stop’s ask about background jobs (#129), one row per agent, until you answer it.
  const asks = h('div.outbox');
  /** @type {Map<string, { jobs: number, text: string, turnId?: string }>} asks the server returned before its session event arrives */
  const asked = new Map();
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
  // The composer’s Stop: an agent whose turn is here, the last speaker first.
  const busyOne = () =>
    sessionsAt(threadId)
      .filter((se) => busy(se) && (!se.sideTurn || se.sideTurn.threadId === threadId))
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
          h('span.dim', a.uploading ? ' · uploading…' : a.kind === 'project-file' ? ' · from the project folder' : a.size ? ` · ${fileSize(a.size)}` : ''),
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
        {
          label: 'Upload from computer',
          desc: side ? 'Or drop files on this thread' : 'Or drop files anywhere in the conversation',
          icon: 'upload',
          run: () => file.click(),
        },
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
        { label: 'From a boilerplate', desc: 'Researcher, Critic, Developer, Indexer, or one you saved', icon: 'agent', run: () => openNewAgent({ threadId }) },
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

  const clear = () => {
    ta.value = '';
    slashTarget = null;
    save();
    autosize();
    paint();
  };

  // ── / and ! (#67) ──
  /** The agent / and ! act for by default: the one the composer replies to. */
  const target = () => {
    const members = sessionsOf(threadId).filter((x) => !x.archived);
    return members.find((x) => x.id === thread()?.lastSpeaker) ?? members[0] ?? null;
  };
  const isMock = (se) => S().personas[se?.personaId]?.backend === 'mock';
  /** Postbox’s own commands, which act on Postbox without a turn. */
  const POSTBOX = [
    ['permissions', 'Its mode, rules, folders and MCP servers', () => openPermissions({ threadId, sessionId: target()?.id })],
    ['mode', 'Ask me, Auto, Accept edits or Run everything', () => openRunChoice('mode', { threadId, sessionId: target()?.id })],
    ['model', 'The model for this conversation', () => openRunChoice('model', { threadId, sessionId: target()?.id })],
    ['effort', 'How much it thinks, for this conversation', () => openRunChoice('effort', { threadId, sessionId: target()?.id })],
    ['add-dir', 'Let it work in another folder', () => addDir()],
    ['mcp', 'Its MCP servers: status, on or off', () => openPermissions({ threadId, sessionId: target()?.id, focus: 'mcp' })],
    ['compact', 'Summarize its context to make room', () => compact()],
    ['stop', 'Stop the agents that are working', () => stopAll()],
    ['rename', 'Rename this conversation', () => openRename(threadId)],
    ['archive', 'Archive its session; restore it any time', () => archive()],
  ];
  const POSTBOX_NAMES = new Set(POSTBOX.map(([n]) => n));
  function addDir() {
    const se = target();
    const projectId = thread()?.projectId;
    if (!se || !projectId) return;
    openFolderPicker(
      projectId,
      (path) =>
        api('/api/permissions/folders', { sessionId: se.id, path })
          .then((r) => toast({ title: `@${se.handle} may work in ${r.path}`, text: 'From its next turn.' }))
          .catch((e) => toast({ title: 'Couldn’t add the folder', text: e.message, level: 'blocking' })),
      { folders: true },
    );
  }
  function compact() {
    const se = target();
    if (!se) return;
    if (isMock(se)) return toast({ title: 'Nothing to compact', text: `@${se.handle} is a mock agent.` });
    runAgentCommand(se, '/compact');
  }
  function stopAll() {
    // In a conversation, Stop reaches its side threads too (#121): its agents wherever their turn is, and the forks
    // answering there. Topic threads keep running: you forked them, and each has its own Stop.
    const t = thread();
    const working = (t?.kind === 'side' || t?.kind === 'topic' ? sessionsAt(threadId) : [...sessionsOf(threadId), ...sideSessionsOf(threadId)]).filter(busy);
    if (!working.length) return say('Nothing is running here.');
    for (const se of working)
      stopSession(se).then(
        (r) => (r?.ask ? askStop(se, r.ask) : say(`Stopped @${se.handle}.`)),
        (e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }),
      );
  }
  function archive() {
    const se = target();
    if (!se) return;
    api(`/api/sessions/${se.id}/archive`, {}).then(
      () => toast({ title: `Archived @${se.handle}’s session`, action: { label: 'Restore', run: () => api(`/api/sessions/${se.id}/restore`, {}) } }),
      (e) => toast({ title: 'Couldn’t archive', text: e.message, level: 'blocking' }),
    );
  }
  /** An agent’s skills and commands: its session’s, else the latest from another session of its persona. */
  function agentCommands(se) {
    if (se.commands?.list?.length) return { list: se.commands.list, earlier: false };
    const other = Object.values(S().sessions)
      .filter((x) => x.personaId === se.personaId && x.id !== se.id && x.commands?.list?.length)
      .sort((a, b) => b.commands.at - a.commands.at)[0];
    return other ? { list: other.commands.list, earlier: true } : { list: [], earlier: false };
  }
  /** Everything the / menu offers for the query, in groups: Postbox’s, then each agent’s. */
  function slashOptions() {
    const q = slash?.query ?? '';
    const match = (name) => name.toLowerCase().includes(q);
    const groups = [{ label: 'Postbox', options: POSTBOX.filter(([n]) => match(n)).map(([name, desc, run]) => ({ name, desc, run })) }];
    for (const se of sessionsOf(threadId).filter((x) => !x.archived)) {
      const { list, earlier } = agentCommands(se);
      const options = list
        .filter((c) => !POSTBOX_NAMES.has(c.name) && match(c.name))
        .slice(0, 40)
        .map((c) => ({ name: c.name, desc: c.description ?? (c.skill ? 'Skill' : 'Command'), hint: c.argumentHint ?? '', se }));
      if (options.length) groups.push({ label: `@${se.handle}’s skills and commands${earlier ? ' · from an earlier session' : ''}`, options });
    }
    return groups.filter((g) => g.options.length);
  }
  const flatOptions = () => slashOptions().flatMap((g) => g.options);
  function updateSlash() {
    const upto = ta.value.slice(0, ta.selectionStart);
    if (!commands || !/^\/[^\s]*$/.test(upto)) {
      if (slash) {
        slash = null;
        paintSlash();
      }
      return;
    }
    const query = upto.slice(1).toLowerCase();
    slash = { query, index: slash?.query === query ? slash.index : 0 };
    paintSlash();
  }
  function paintSlash() {
    if (mention) return;
    menuBox.replaceChildren();
    ta.removeAttribute('aria-activedescendant');
    if (!slash) {
      ta.removeAttribute('aria-controls');
      return;
    }
    const groups = slashOptions();
    const n = groups.reduce((a, g) => a + g.options.length, 0);
    if (!n) {
      menuBox.append(h('div.menu.mention-menu.slash-menu', h('div.label', 'No command by that name'), h('p.small.dim', 'Enter sends it as a message.')));
      return;
    }
    slash.index = Math.min(slash.index, n - 1);
    let i = 0;
    const box = h(
      'div.menu.mention-menu.slash-menu',
      { role: 'listbox', id: 'slash-list', 'aria-label': 'Commands' },
      groups.map((g, gi) =>
        h(
          'div',
          { role: 'group', 'aria-labelledby': `slash-g-${gi}` },
          h('div.label', { id: `slash-g-${gi}` }, g.label),
          g.options.map((o) => {
            const k = i++;
            return h(
              'div.mi',
              {
                role: 'option',
                id: `slash-${k}`,
                'aria-selected': String(k === slash.index),
                class: k === slash.index ? 'active' : '',
                onmousedown: (e) => {
                  e.preventDefault();
                  pickSlash(o);
                },
              },
              h('span.grow', h('span.mono', `/${o.name}`), o.hint ? h('span.dim.mono', ` ${o.hint}`) : null, h('span.d', o.desc)),
              k === slash.index ? h('span.k', 'Enter') : null,
            );
          }),
        ),
      ),
    );
    menuBox.append(box);
    ta.setAttribute('aria-controls', 'slash-list');
    ta.setAttribute('aria-activedescendant', `slash-${slash.index}`);
    document.getElementById(`slash-${slash.index}`)?.scrollIntoView({ block: 'nearest' });
  }
  function pickSlash(o) {
    slash = null;
    paintSlash();
    if (o.run) {
      clear();
      ta.focus();
      o.run();
      return;
    }
    // An agent’s skill or command: fill /name, show its hint, and send it as that agent’s turn.
    slashTarget = { sessionId: o.se.id, handle: o.se.handle, name: o.name, argumentHint: o.hint };
    ta.value = `/${o.name} `;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    save();
    autosize();
    paint();
  }
  /** Runs a skill or command as an agent’s turn: the line is the whole prompt. */
  async function runAgentCommand(se, line) {
    try {
      await api(`/api/threads/${threadId}/agent-command`, { sessionId: se.id, text: line });
      return true;
    } catch (e) {
      toast({ title: `@${se.handle} couldn’t run ${line.split(/\s/)[0]}`, text: e.message, level: 'blocking' });
      return false;
    }
  }
  /** What a line starting with / or ! does when sent, or null to send it as a message. */
  function commandFor(text) {
    if (!commands) return null;
    if (text.startsWith('!'))
      return async () => {
        try {
          await api(`/api/threads/${threadId}/shell`, { command: text.slice(1).trim() });
          return true;
        } catch (e) {
          toast({ title: 'The command didn’t run', text: e.message, level: 'blocking' });
          return false;
        }
      };
    const m = text.match(/^\/([\w:.@/-]+)(\s[\s\S]*)?$/);
    if (!m) return null;
    const [, name, rest] = m;
    const own = POSTBOX.find(([n]) => n === name);
    if (own && !rest?.trim())
      return async () => {
        own[2]();
        return true;
      };
    const picked = slashTarget?.name === name ? sessionsOf(threadId).find((x) => x.id === slashTarget.sessionId) : null;
    const reply = target();
    const se =
      picked ??
      (reply && agentCommands(reply).list.some((c) => c.name === name) ? reply : null) ??
      sessionsOf(threadId).find((x) => !x.archived && agentCommands(x).list.some((c) => c.name === name));
    return se ? () => runAgentCommand(se, text) : null;
  }

  async function submit(sendNow = false) {
    const text = ta.value.trim();
    if (attachments.some((a) => a.uploading)) {
      toast({ title: 'Still uploading', text: 'Send once the files finish uploading.' });
      return;
    }
    if (!text && !attachments.length) return;
    const command = !attachments.length ? commandFor(text) : null;
    if (command) {
      if (await command()) clear();
      return;
    }
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

  // @-mention autocomplete, and # for a side or topic thread of this conversation (#121)
  function updateMention() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|[\s(])([@#])([^\s@#()]*)$/);
    if (!m || (m[2] === '@' && !/^[A-Za-z0-9_-]*$/.test(m[3])) || (m[2] === '#' && !threadsHere().length)) {
      mention = null;
      paintMention();
      return;
    }
    const query = m[3].toLowerCase();
    mention = { kind: m[2], start: upto.length - m[3].length - 1, query, index: mention?.query === query && mention.kind === m[2] ? mention.index : 0 };
    paintMention();
  }
  /** The conversation’s side and topic threads, newest first, other than this one. */
  function threadsHere() {
    const t = thread();
    const conv = t?.kind === 'side' || t?.kind === 'topic' ? t.parentId : threadId;
    return Object.values(S().threads)
      .filter((x) => x.parentId === conv && (x.kind === 'side' || x.kind === 'topic') && x.id !== threadId && !x.deleting)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  function candidates() {
    if (mention.kind === '#')
      return threadsHere()
        .filter((x) => x.title.toLowerCase().includes(mention.query))
        .slice(0, 6)
        .map((x) => ({ thread: x }));
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
    const box =
      mention.kind === '#'
        ? threadMenu(list)
        : h(
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
                    pick({ p });
                  },
                },
                ring,
                h(
                  'span.grow',
                  `@${p.handle}`,
                  mockMarker(se ?? p),
                  h(
                    'span.d',
                    se?.archived ? 'Archived · restore it to wake it' : se ? `Here · ${stateWord(se.state).toLowerCase()}` : 'Not here · joins when woken',
                  ),
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
  /** Threads to link, as the menu for #. The link is what Copy link gives, so an agent reads it the same way. */
  function threadMenu(list) {
    return h(
      'div.menu.mention-menu',
      { role: 'listbox', id: 'mention-list', 'aria-label': 'Threads' },
      h('div.label', 'Link a thread'),
      list.map(({ thread: x }, i) =>
        h(
          'div.mi',
          {
            role: 'option',
            id: `mention-${i}`,
            'aria-selected': String(i === mention.index),
            class: i === mention.index ? 'active' : '',
            onmousedown: (e) => {
              e.preventDefault();
              pick({ thread: x });
            },
          },
          icon('thread', 'i-sm'),
          h('span.grow', x.title, h('span.d', x.kind === 'side' ? 'Side thread' : 'Topic thread')),
          i === mention.index ? h('span.k', 'Enter') : null,
        ),
      ),
    );
  }
  function pick(c) {
    if (c.thread) insertText(`[${c.thread.title.replace(/[[\]]/g, '')}](${threadLink(c.thread.id)})`);
    else insertText(`@${c.p.handle}`);
  }
  function insertText(text) {
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}${text} ${after}`;
    const pos = before.length + text.length + 1;
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
    updateSlash();
    // The hint line follows what the line will do: a picked skill, a ! command, or a message.
    if (slashTarget && !ta.value.startsWith(`/${slashTarget.name}`)) slashTarget = null;
    if (ta.value.startsWith('!') || hint.dataset.mode || (commands && ta.value.startsWith('/'))) paint();
  });
  ta.addEventListener('click', () => {
    updateMention();
    updateSlash();
  });
  ta.addEventListener('blur', () =>
    setTimeout(() => {
      // The menus stay when focus came straight back (the window lost it and got it back).
      if (document.activeElement === ta) return;
      mention = null;
      paintMention();
      if (slash) {
        slash = null;
        paintSlash();
      }
    }, 120),
  );
  ta.addEventListener('keydown', (e) => {
    if (slash && !mention) {
      const n = flatOptions().length;
      if (n && e.key === 'ArrowDown') {
        e.preventDefault();
        slash.index = (slash.index + 1) % n;
        paintSlash();
        return;
      }
      if (n && e.key === 'ArrowUp') {
        e.preventDefault();
        slash.index = (slash.index - 1 + n) % n;
        paintSlash();
        return;
      }
      if (n && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        pickSlash(flatOptions()[slash.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slash = null;
        paintSlash();
        return;
      }
    }
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
        pick(candidates()[mention.index]);
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

  const el = h(
    'div.composer',
    h('div.col', status, asks, queue, menuBox, att, h('div.composer-box', plus, commandsButton, ta, action), hint, file, corpusFile),
  );

  // Drop files: the main composer takes drops anywhere in the window. A side or topic composer takes drops on
  // its own panel (see dropZone below), and stops them there so the main composer doesn’t take them too.
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (side) e.stopPropagation();
    addFiles([...e.dataTransfer.files]);
  };
  const onDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (side) e.stopPropagation();
  };
  /** @type {EventTarget} */
  let zone = side ? el : window;
  const listen = () => {
    zone.addEventListener('drop', onDrop);
    zone.addEventListener('dragover', onDragOver);
  };
  const unlisten = () => {
    zone.removeEventListener('drop', onDrop);
    zone.removeEventListener('dragover', onDragOver);
  };
  listen();

  function paint() {
    const t = thread();
    if (!t) return;
    const b = busyOne();
    action.replaceChildren();
    action.className = b ? 'btn stop' : 'btn send';
    action.textContent = b ? 'Stop' : 'Send';
    action.onclick = b
      ? () =>
          stopSession(b)
            .then((r) => (r?.ask ? askStop(b, r.ask) : say(`Stopped @${b.handle}.`)))
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
    // An ask about a turn that has since ended goes with it.
    for (const id of [...asked.keys()]) if (!busy(S().sessions[id])) asked.delete(id);
    syncList(
      asks,
      sessionsOf(threadId).filter((se) => busy(se) && (se.stopAsk || asked.has(se.id))),
      (se) => se.id,
      (se) => stopAskRow(se),
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
    // What Enter will do with a / or ! line (#67).
    const line = ta.value.trimStart();
    // ! outside a conversation’s own composer would go to the agent as plain text: say so before it’s sent (#104).
    const mode = offline
      ? ''
      : !commands
        ? line.startsWith('!')
          ? 'no-shell'
          : ''
        : line.startsWith('!')
          ? 'shell'
          : slashTarget && line.startsWith(`/${slashTarget.name}`)
            ? 'skill'
            : '';
    if (mode) hint.dataset.mode = mode;
    else delete hint.dataset.mode;
    const folder = mode === 'shell' ? commandFolder() : null;
    fill(
      hint,
      mode === 'shell'
        ? h(
            'span',
            folder
              ? ['Runs in ', h('span.mono', folder), ' as you, with Enter. ']
              : target() && !isMock(target())
                ? ['Runs in ', h('b', `@${target().handle}`), '’s own workspace, as you, with Enter. ']
                : 'This conversation has no folder to run commands in. ',
            'The agents read it and its output on their next turn.',
          )
        : mode === 'no-shell'
          ? h(
              'span',
              h('b', '! runs commands only in the conversation’s own composer.'),
              ` Here, this goes to ${topic ? 'the agent' : 'the agents'} as a message. To run it, send it from the conversation.`,
            )
          : mode === 'skill'
            ? h(
                'span',
                'Enter runs ',
                h('span.mono', `/${slashTarget.name}`),
                slashTarget.argumentHint ? [' ', h('span.mono.dim', slashTarget.argumentHint)] : null,
                ' as ',
                h('b', `@${slashTarget.handle}`),
                '’s turn',
              )
            : offline
              ? h('span', 'You’re offline. Messages you send now go out when the connection is back.')
              : topic
                ? h('span', 'Replies stay in this thread. @ brings in another agent from the conversation.')
                : side
                  ? h('span', 'Anything you send here adds you to this side thread.')
                  : [
                      members.length > 1 && last ? h('span', 'Replying to ', h('b', `@${last.handle}`), mockMarker(last), ' (last speaker)') : null,
                      h('span', 'Enter to send · Shift+Enter for a new line'),
                      h('span.hide-sm', '@ to wake an agent · / for commands · ! to run a command · + to add a file or an agent'),
                    ],
    );
  }
  /**
   * Where `!` runs, as far as the page knows: the folder of the agent that replies here, else the project’s. A Claude
   * Code or Agent SDK agent with neither works in a workspace of its own, which the server finds (its adapter’s folderFor).
   */
  function commandFolder() {
    const se = target();
    const p = se ? S().personas[se.personaId] : null;
    return se?.personaSnapshot?.folder || p?.folder || S().projects[thread()?.projectId]?.folder || null;
  }
  /** Stop found background jobs running: the ask shows above the composer, and its first choice takes focus. */
  function askStop(se, ask) {
    asked.set(se.id, ask);
    paint();
    asks.querySelector(`[data-key="${se.id}"] button`)?.focus();
  }
  /**
   * “@developer has 1 background job running. Stop it too?” A choice you make there and then, so it’s a quiet row, not
   * a card: Stop it too, Keep running (the agent stops, its jobs run on), or Escape and the agent carries on.
   */
  function stopAskRow(se) {
    const ask = se.stopAsk ?? asked.get(se.id);
    const one = (ask?.jobs ?? 1) === 1;
    const done = () => {
      asked.delete(se.id);
      paint();
      (action.isConnected ? action : ta).focus();
    };
    const choose = (jobs) => {
      asked.delete(se.id);
      stopSession(se, jobs, ask?.turnId ?? null)
        .then((r) =>
          say(
            r?.ended
              ? `@${se.handle}’s reply had already ended.`
              : jobs === 'keep'
                ? `Stopped @${se.handle}. ${one ? 'Its background job keeps' : 'Its background jobs keep'} running.`
                : `Stopped @${se.handle} and ${one ? 'its background job' : 'its background jobs'}.`,
          ),
        )
        .catch((e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }))
        .finally(done);
    };
    const dismiss = () => {
      api(`/api/sessions/${se.id}/stop-ask`, undefined, 'DELETE').catch(() => {});
      done();
    };
    return h(
      'div.queued.stop-ask',
      {
        role: 'group',
        'aria-label': `Stop @${se.handle}`,
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        },
      },
      h('span.q-text', ask?.text ?? `@${se.handle} has background jobs running. Stop them too?`),
      h('button.btn.sm.send', { type: 'button', onclick: () => choose('stop') }, one ? 'Stop it too' : 'Stop them too'),
      h('button.btn.sm', { type: 'button', onclick: () => choose('keep') }, 'Keep running'),
      h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Don’t stop @${se.handle}`, onclick: dismiss }, icon('x', 'i-sm')),
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
    /** A side or topic composer: take drops on this element (its whole panel) instead of on the composer alone. */
    dropZone(target) {
      if (!side) return;
      unlisten();
      zone = target;
      listen();
    },
    destroy() {
      off();
      unlisten();
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
  // A topic thread’s agents, with the same rows and quick panel as the sidebar’s (#105): its composer has no / commands.
  const who = topic ? agentsSection(sideId, { label: 'Agents in this thread' }) : null;
  // One summary at a time (#93): from the request until it’s posted or the turn ends, the button waits. The
  // server keeps the request on the thread, so a reload or a second tab waits too, and it refuses a second one.
  // From the click until the server’s own state shows the request: its agent at work on it.
  let asking = false;
  const pendingSummary = () => {
    const ask = S().threads[sideId]?.summaryPending;
    const se = ask && S().sessions[ask.sessionId];
    const working = !!(se && !se.archived && ['think', 'gen', 'tool', 'needs'].includes(se.state));
    if (working) asking = false;
    return asking || working;
  };
  const summarize = topic
    ? h(
        'button.btn.sm',
        {
          type: 'button',
          title: 'Ask the thread’s agent for a short summary, and post it in the conversation',
          onclick: () => {
            asking = true;
            paintSummarize();
            api(`/api/threads/${sideId}/summarize`, {})
              .then(() => toast({ title: 'Summary requested', text: `It will appear in ${parent?.title ?? 'the conversation'} when it’s written.` }))
              .catch((e) => {
                asking = false;
                toast({ title: 'Couldn’t ask for a summary', text: e.message, level: 'blocking' });
              })
              .finally(paintSummarize);
          },
        },
        'Summarize back',
      )
    : null;
  const paintSummarize = () => {
    if (!summarize) return;
    const waiting = pendingSummary();
    summarize.disabled = waiting || !sessionsOf(sideId).some((x) => !x.archived);
    const label = waiting ? 'Summary requested…' : 'Summarize back';
    if (summarize.textContent !== label) summarize.textContent = label;
  };
  paintSummarize();
  const off = client.on((ch) => {
    if ((ch.type === 'thread' && ch.data.id === sideId) || (ch.type === 'session' && ch.data.threadId === sideId) || ch.type === 'load') paintSummarize();
  });
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
      copyLink(sideId, topic),
      h(
        'button.btn.icon.sm.ghost',
        { type: 'button', 'aria-label': topic ? 'Close thread' : 'Close side thread', onclick: () => navigate(`#/t/${parentId}`) },
        icon('x'),
      ),
    ),
    who ? h('div.sp-agents', who.el) : null,
    body,
    h('div.sp-foot', comp.el),
  );
  // A file dropped anywhere on the panel attaches to the panel’s composer, not the conversation’s.
  comp.dropZone(el);
  requestAnimationFrame(() => tr.settle());
  return {
    el,
    destroy() {
      off();
      who?.destroy();
      tr.destroy();
      comp.destroy();
    },
  };
}

/**
 * Copy link (#121): the thread’s address, to paste in a message. An agent that gets it can read the thread with
 * read_conversation, and the composer’s # inserts the same link.
 */
function copyLink(threadId, topic) {
  const b = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(threadLink(threadId));
          say('Link copied. Paste it in a message, and the agent can read this thread.');
          b.textContent = 'Copied';
        } catch {
          toast({ title: 'Couldn’t copy the link', text: threadLink(threadId) });
        }
        setTimeout(() => {
          b.textContent = 'Copy link';
        }, 2000);
      },
      'aria-label': topic ? 'Copy link to this topic thread' : 'Copy link to this side thread',
    },
    'Copy link',
  );
  return b;
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
