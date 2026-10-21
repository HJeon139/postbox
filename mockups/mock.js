// Mockup helpers: the status ring, the rail and the phone ring strip, drawn from one set of sample data.
// Stage 2 reuses <pb-ring>; the rail data here is sample content only.

const STATE_WORD = { idle: 'Idle', think: 'Thinking', gen: 'Generating', tool: 'Calling tools', needs: 'Needs you', failed: 'Failed' };
const STATE_VAR = { idle: '--st-idle', think: '--st-think', gen: '--st-gen', tool: '--st-tool', needs: '--accent', failed: '--alert' };

export const PROJECTS = {
  corpus: {
    name: 'Book corpus', folder: '~/books',
    threads: [
      { id: 'explorer', title: 'Corpus explorer', agent: 'librarian', state: 'gen', ctx: 34, href: '04-corpus-app.html' },
      { id: 'index', title: 'Index the shelf', agent: 'indexer', state: 'tool', ctx: 62, subs: 'gen:22:chunker,tool:31:embedder', href: '09-errors.html' },
      { id: 'spec', title: 'Corpus schema spec', agent: 'critic', state: 'idle', ctx: 18, badge: 1, href: '07-review.html' },
      { id: 'tour', title: 'Catalog tour', agent: 'librarian', state: 'idle', ctx: 12, href: '06-catalog.html' },
    ],
    rooms: [
      { id: 'planning', title: 'Corpus planning', agents: [['indexer', 'tool', 62, 'gen:22:chunker,tool:31:embedder'], ['researcher', 'idle', 41, '']], state: 'tool', href: '03-thread.html' },
    ],
  },
  research: {
    name: 'Agent research', folder: '~/research',
    threads: [
      { id: 'react', title: 'ReAct, step by step', agent: 'researcher', state: 'gen', ctx: 41, subs: 'think:18:reader', href: '05-explainer.html' },
      { id: 'memory', title: 'Agent memory papers', agent: 'researcher', state: 'needs', ctx: 55, href: '01-overview.html' },
    ],
    rooms: [],
  },
};

const NEW_THREAD = { id: 'new', title: 'New thread', agent: 'librarian', state: 'idle', ctx: 0, href: '02-empty.html' };

const NS = 'http://www.w3.org/2000/svg';

// Sizes: [agent ring radius, stroke, ring pitch, max subagent rings shown]
const RING_SIZES = { xs: [4.5, 1.75, 3, 2], sm: [6, 2, 3.5, 2], lg: [10, 3, 5, 3] };

// One ring: the arc's length is the share of context in use; its motion says what that agent is doing.
// Every motion eases in, eases out, then rests: generating turns the arc once; thinking sends a short bulge
// of thickness from tail to head; calling tools sends a dot across the free part of the ring and back.
function ringSvg(c, r, sw, state, ctx) {
  const color = `var(${STATE_VAR[state] ?? '--st-idle'})`;
  const C = 2 * Math.PI * r;
  const L = (C * ctx) / 100;
  let out = `<circle class="track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${sw}"/>`;
  if (state === 'think' && L > 0) {
    // Short overlapping segments with round caps read as one arc until the bulge passes through them.
    const n = Math.max(6, Math.round(L / (sw * 1.1)));
    const seg = L / n;
    out += `<g transform="rotate(-90 ${c} ${c})" style="--sw:${sw}px">`;
    for (let i = 0; i < n; i++) {
      // Segment i starts swelling when an eased position reaches it: slow at both ends, quick in the middle.
      const delay = Math.round((1400 * Math.acos(1 - (2 * i) / (n - 1))) / Math.PI);
      out += `<circle class="arc seg" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
        stroke-linecap="round" stroke-dasharray="${seg} ${C - seg}" stroke-dashoffset="${-i * seg}" style="--d:${delay}ms"/>`;
    }
    out += `</g>`;
  } else {
    out += `<g transform="rotate(-90 ${c} ${c})"><circle class="arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}"
      stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${L} ${C - L}"/></g>`;
  }
  if (state === 'tool') {
    const margin = ((sw * 1.6) / r) * (180 / Math.PI);
    const a1 = 3.6 * ctx + margin, a2 = 360 - margin;
    const rest = a1 < a2 ? a1 : 3.6 * ctx + (360 - 3.6 * ctx) / 2;
    out += `<circle class="dot${a1 >= a2 ? ' still' : ''}" cx="${c}" cy="${c - r}" r="${Math.max(1.3, sw * 0.8)}" fill="${color}"
      style="--a1:${a1}deg;--a2:${a2}deg;transform:rotate(${rest}deg)"/>`;
  }
  return out;
}

// subs="tool:31:embedder,gen:22:chunker" — one ring per subagent, outside the agent's own ring.
const parseSubs = (spec) => (spec || '').split(',').filter(Boolean).map((p) => {
  const [state, ctx, name] = p.split(':');
  return { state, ctx: Math.max(0, Math.min(100, +ctx || 0)), name: name || 'subagent' };
});

class PbRing extends HTMLElement {
  static observedAttributes = ['state', 'ctx', 'subs', 'size', 'name'];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const state = this.getAttribute('state') || 'idle';
    const ctx = Math.max(0, Math.min(100, +this.getAttribute('ctx') || 0));
    const subs = parseSubs(this.getAttribute('subs'));
    const size = this.getAttribute('size') || 'sm';
    const name = this.getAttribute('name') || 'Agent';
    const [rb, sw, pitch, cap] = RING_SIZES[size];
    const shown = subs.slice(0, cap);
    const R = rb + shown.length * pitch;
    const S = Math.ceil(2 * (R + sw / 2 + 1));
    const c = S / 2;
    let inner = ringSvg(c, rb, sw, state, ctx);
    shown.forEach((sa, i) => { inner += ringSvg(c, rb + (i + 1) * pitch, sw * 0.8, sa.state, sa.ctx); });
    if (state === 'needs') inner += `<circle class="pulse" cx="${c}" cy="${c}" r="${R + sw}" fill="none" stroke-width="1.4"/>`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', S); svg.setAttribute('height', S); svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
    svg.innerHTML = inner;
    svg.setAttribute('role', 'img');
    const subText = subs.length ? `; ${subs.length} subagent${subs.length === 1 ? '' : 's'}: ` + subs.map((x) => `${x.name} ${STATE_WORD[x.state].toLowerCase()}, ${x.ctx}%`).join('; ') : '';
    svg.setAttribute('aria-label', `${name}: ${STATE_WORD[state]}, ${ctx}% of context used${subText}`);
    const parts = [svg];
    if (subs.length > cap) {
      const more = document.createElement('span');
      more.className = 'ring-more';
      more.textContent = `+${subs.length - cap}`;
      more.setAttribute('aria-hidden', 'true');
      parts.push(more);
    }
    this.replaceChildren(...parts);
  }
}

customElements.define('pb-ring', PbRing);

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const ring = (agent, state, ctx, subs, size = 'sm') => `<pb-ring name="@${agent}" state="${state}" ctx="${ctx}" subs="${subs || ''}" size="${size}"></pb-ring>`;

function rowHtml(t, active) {
  const current = t.id === active ? ' aria-current="page"' : '';
  const rings = t.agents
    ? `<span class="stack">${t.agents.map(([a, s, c, n]) => ring(a, s, c, n, 'xs')).join('')}</span>`
    : ring(t.agent, t.state, t.ctx, t.subs);
  const who = t.agents ? t.agents.map(([a]) => '@' + a).join(', ') : `@${t.agent} · ${STATE_WORD[t.state].toLowerCase()}`;
  const badge = t.badge ? `<span class="badge" aria-label="${t.badge} unread">${t.badge}</span>` : '';
  return `<a class="row" href="${t.href}"${current}><span class="ring-slot">${rings}</span><span class="name"><span>${esc(t.title)}</span><span class="sub">${esc(who)}</span></span>${badge}</a>`;
}

// states="index:idle:62:0" lets a page show a thread in a different state from the sample data.
function applyOverrides(p, spec) {
  for (const part of (spec || '').split(',').filter(Boolean)) {
    const [id, state, ctx, sub] = part.split(':');
    const t = [...p.threads, ...p.rooms].find((x) => x.id === id);
    if (t) Object.assign(t, { state, ctx: +ctx, subs: +sub ? t.subs : '' });
  }
}

class PbRail extends HTMLElement {
  connectedCallback() {
    const p = PROJECTS[this.getAttribute('project') || 'corpus'];
    const other = this.getAttribute('project') === 'research' ? PROJECTS.corpus : PROJECTS.research;
    const active = this.getAttribute('active');
    applyOverrides(p, this.getAttribute('states'));
    const otherNeeds = [...other.threads, ...other.rooms].some((t) => t.state === 'needs');
    this.outerHTML = `<nav class="rail" aria-label="Threads">
      <button class="btn ghost rail-proj" aria-haspopup="menu" style="justify-content:flex-start;height:auto">
        <span class="i i-folder"></span><span class="grow" style="text-align:left"><span class="title" style="font-size:14px;display:block">${esc(p.name)}</span><span class="small dim mono">${esc(p.folder)}</span></span><span class="i i-down"></span>
      </button>
      ${otherNeeds ? `<a class="row" href="01-overview.html" style="min-height:32px"><span class="g g-needs"></span><span class="name small">${esc(other.name)} · 1 needs you</span></a>` : ''}
      <a class="row" href="01-overview.html" style="min-height:32px"><span class="i i-agent dim"></span><span class="name">Overview</span><kbd>⌃J</kbd></a>
      <div class="rail-sec"><span class="label">Threads</span><button class="btn ghost icon sm" aria-label="New thread"><span class="i i-plus"></span></button></div>
      ${active === 'new' ? rowHtml(NEW_THREAD, active) : ''}
      ${p.threads.map((t) => rowHtml(t, active)).join('')}
      ${p.rooms.length ? `<div class="rail-sec"><span class="label">Rooms</span><button class="btn ghost icon sm" aria-label="New room"><span class="i i-plus"></span></button></div>` : ''}
      ${p.rooms.map((t) => rowHtml(t, active)).join('')}
      <div class="rail-foot">
        <a class="row" href="12-card-menu.html" style="min-height:32px"><span class="i i-archive dim"></span><span class="name dim">Archived</span><span class="small dim">2</span></a>
        <a class="row" href="11-new-agent.html" style="min-height:32px"><span class="i i-edit dim"></span><span class="name dim">Personas</span></a>
      </div>
    </nav>`;
  }
}
customElements.define('pb-rail', PbRail);

class PbStrip extends HTMLElement {
  connectedCallback() {
    const p = PROJECTS[this.getAttribute('project') || 'corpus'];
    const active = this.getAttribute('active');
    applyOverrides(p, this.getAttribute('states'));
    const items = [...(active === 'new' ? [NEW_THREAD] : []), ...p.threads, ...p.rooms].map((t) => {
      const r = t.agents ? `<span class="stack">${t.agents.map(([a, s, c, n]) => ring(a, s, c, n, 'xs')).join('')}</span>` : ring(t.agent, t.state, t.ctx, t.subs);
      const badge = t.badge ? `<span class="badge">${t.badge}</span>` : '';
      return `<a href="${t.href}"${t.id === active ? ' aria-current="page"' : ''}>${r}${badge}<span>${esc(t.title)}</span></a>`;
    });
    this.outerHTML = `<nav class="ringstrip" aria-label="Threads"><a href="01-overview.html"><span class="i i-agent" style="width:28px;height:28px"></span><span>Overview</span></a>${items.join('')}</nav>`;
  }
}
customElements.define('pb-strip', PbStrip);

// Keep the chosen theme while clicking between mockups.
const q = new URLSearchParams(location.search);
if (q.get('theme')) {
  addEventListener('click', (e) => {
    const a = e.target.closest('a[href$=".html"]');
    if (a && !a.href.includes('?')) a.href += `?theme=${q.get('theme')}`;
  });
}
