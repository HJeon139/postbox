// Boot, routing, color mode, notifications, keyboard shortcuts and hover-card content.

import './ring.mjs';
import { h, $, icon } from './dom.mjs';
import { client, load, connect, needsYou } from './client.mjs';
import { topbar, mountRail, mountOverview, nextNeedsYou } from './shell.mjs';
import { mountTranscript, mountComposer, mountSidePanel, focusComposer } from './thread.mjs';
import { route, navigate, toast, setAttention, initHoverCards, mdNode, say } from './ui.mjs';
import { openPalette } from './sheets.mjs';
import { onThemeChange } from './apps.mjs';
import { ringFor } from './ring.mjs';

const root = $('#root');
let mounted = [];
let current = null;

function render() {
  for (const m of mounted) m.destroy?.();
  mounted = [];
  const r = route();
  const archived = location.hash === '#/archived';
  if (r.view === 'thread' && !client.state.threads[r.threadId]) { navigate('#/'); return; }
  current = r;
  if (r.view === 'overview') {
    const ov = mountOverview({ archived });
    mounted.push(ov);
    root.replaceChildren(h('div.app.no-rail', topbar({ title: archived ? 'Archived' : 'Overview' }), ov.el));
    setAttention(needsYou().length, 'Overview');
    return;
  }
  const t = client.state.threads[r.threadId];
  if (t.kind === 'side') { navigate(`#/t/${t.parentId}/side/${t.id}`); return; }
  const rail = mountRail(t.id);
  const tr = mountTranscript(t.id);
  const comp = mountComposer(t.id);
  const jumpBox = h('div.jump', { hidden: true });
  tr.setJump((n) => {
    jumpBox.hidden = !n;
    jumpBox.replaceChildren(h('button.btn.sm', { type: 'button', onclick: () => tr.scrollToEnd(true) }, icon('down', 'i-sm'), `Jump to latest · ${n} new`));
  });
  comp.el.querySelector('.col').style.position = 'relative';
  comp.el.querySelector('.col').prepend(jumpBox);
  mounted.push(rail, tr, comp);
  const side = r.sideId ? mountSidePanel(t.id, r.sideId) : null;
  if (side) mounted.push(side);
  const shell = h('div.app', { class: side ? 'has-panel' : '' }, topbar({ title: t.title, threadId: t.id }), rail.el, h('div.main', rail.strip, tr.el, comp.el), side?.el);
  root.replaceChildren(shell);
  requestAnimationFrame(() => tr.scrollToEnd());
  view(t.id);
  setAttention(needsYou().length, t.title);
}

// Tell the server which thread is open, so finished replies there don’t count as unread.
let viewTimer = 0;
function view(threadId) {
  clearInterval(viewTimer);
  const ping = () => { if (document.visibilityState === 'visible' && route().threadId === threadId) fetch(`/api/threads/${threadId}/view`, { method: 'POST' }).catch(() => {}); };
  ping();
  viewTimer = setInterval(ping, 10000);
}
document.addEventListener('visibilitychange', () => { if (current?.threadId) view(current.threadId); });

// ── Color mode ──────────────────────────────────────────────────────────────────────────

const media = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pref = client.state?.settings?.theme ?? 'system';
  try { localStorage.setItem('pb-theme', pref); } catch {}
  const mode = pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
  if (document.documentElement.dataset.theme !== mode) { document.documentElement.dataset.theme = mode; onThemeChange(); }
}
media.addEventListener('change', applyTheme);

// ── Live updates that change the shell ──────────────────────────────────────────────────

client.on((ch) => {
  if (ch.type === 'settings' || ch.type === 'load') applyTheme();
  if (ch.type === 'notify') notify(ch.data);
  if (['thread', 'remove', 'project'].includes(ch.type) || (ch.type === 'session' && topbarChanged(ch.data))) refreshTop();
  if (ch.type === 'remove' && ch.data.kind === 'thread' && route().threadId === ch.data.id) navigate('#/');
  if (ch.type === 'connection') {
    if (client.connection === 'reconnecting' && client.attempts === 1) say('Connection lost. Reconnecting.');
    if (client.connection === 'open' && ch.was === 'reconnecting') say('Reconnected.');
  }
  setAttention(needsYou().length, current?.view === 'thread' ? client.state.threads[current.threadId]?.title ?? 'Postbox' : 'Overview');
});

const topSig = new Map();
function topbarChanged(se) {
  const sig = `${se.needs?.kind}|${se.archived}|${se.deleting}`;
  const changed = topSig.get(se.id) !== sig;
  topSig.set(se.id, sig);
  return changed;
}
function refreshTop() {
  const old = root.querySelector('header.topbar');
  if (!old || !current) return;
  if (current.view === 'thread') {
    const t = client.state.threads[current.threadId];
    if (!t) return;
    // Members changed (an agent joined or left): rebuild the whole view.
    const members = old.querySelectorAll('.present .who-chip').length;
    if (members !== t.members.filter((id) => client.state.sessions[id] && !client.state.sessions[id].archived && !client.state.sessions[id].deleting).length) { render(); return; }
    old.replaceWith(topbar({ title: t.title, threadId: t.id }));
  } else old.replaceWith(topbar({ title: location.hash === '#/archived' ? 'Archived' : 'Overview' }));
}

function notify(d) {
  if (d.level !== 'blocking') return; // informational events are still badges, not toasts
  if (route().threadId === d.threadId && document.visibilityState === 'visible') { say(`${d.title}. ${d.text}`); return; }
  const se = client.state.sessions[d.sessionId];
  toast({ title: d.title, text: d.text, level: 'blocking', ring: se ? ringFor(se, 'sm') : null, action: { label: 'Go', run: () => navigate(`#/t/${d.threadId}`) }, timeout: 12000 });
}

// ── Keyboard ────────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') { e.preventDefault(); nextNeedsYou(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  // Alt+↑/↓ moves between turns and blocks; Alt+End returns to the composer.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const items = [...document.querySelectorAll('#main > .item')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.findIndex((n) => n.contains(document.activeElement));
    const next = items[at < 0 ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
  if (e.altKey && e.key === 'End') { e.preventDefault(); focusComposer(); }
});

// ── Hover cards: citations and glossary terms ───────────────────────────────────────────

initHoverCards((trigger) => {
  const itemEl = trigger.closest('[data-key]');
  const threadId = trigger.closest('[data-thread]')?.dataset.thread;
  if (trigger.classList.contains('cite')) {
    const it = (client.state.items[threadId] ?? []).find((x) => x.id === itemEl?.dataset.key);
    const n = +trigger.dataset.cite;
    const s = it?.sources?.[n - 1];
    if (!s) return null;
    const arxiv = s.url?.match(/arxiv\.org\/abs\/([\d.]+)/)?.[1];
    return {
      label: `Source ${n}`,
      head: [h('span.label', `Source ${n}${arxiv ? ` · arXiv ${arxiv}` : ''}`), h('b', s.title), h('span.small.dim', [s.authors, s.year].filter(Boolean).join(' · '))],
      body: [s.note ? h('p', h('span.dim', 'Why it’s cited: '), s.note) : null,
        h('div.hc-links', s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, ''), ' ', icon('link', 'i-sm')) : null,
          h('a', { href: `#src-${it.id}-${n}`, onclick: (e) => { e.preventDefault(); document.getElementById(`src-${it.id}-${n}`)?.scrollIntoView({ block: 'center' }); } }, 'Show in sources'))],
    };
  }
  const t = client.state.threads[threadId];
  const g = { ...(client.state.glossary[t?.parentId] ?? {}), ...(client.state.glossary[threadId] ?? {}) }[trigger.dataset.term];
  if (!g) return { label: 'Not defined yet', head: [h('span.label', 'Glossary'), h('b', trigger.textContent)], body: [h('p.dim', 'Not defined yet. The agent has been asked to define it.')] };
  return { label: `Glossary: ${g.term}`, head: [h('span.label', 'Glossary'), h('b', g.term)], body: [mdNode(g.definition), h('span.small.dim', `Defined by @${g.by}${g.source ? ` · ${g.source}` : ''}`)] };
});

// ── Boot ────────────────────────────────────────────────────────────────────────────────

addEventListener('hashchange', render);
try {
  await load();
  applyTheme();
  connect();
  render();
} catch (e) {
  root.replaceChildren(h('div', { style: { padding: '24px' } }, h('h1.title', 'Postbox couldn’t start'), h('p', e.message)));
}
