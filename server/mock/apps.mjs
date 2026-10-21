// Apps the mock agent writes. Each is plain HTML with inline style and script, the same thing a real
// agent would send to show_app. Inside the sandbox they use the preloaded kit: Workbench classes and
// tokens, and window.postbox for the bridge (query, send, saveState, restoreState, anchors, charts).

export const explorerApp = ({ withYears = false } = {}) => `
<style>
  .xp { display: grid; grid-template-columns: 230px minmax(0, 1fr); min-height: 440px; }
  .xp-side { border-right: 1px solid var(--line); padding: 14px; display: flex; flex-direction: column; gap: 16px; background: var(--sunk); }
  .xp-main { display: flex; flex-direction: column; min-width: 0; }
  .xp-search { display: flex; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); align-items: center; }
  .xp-status { padding: 8px 14px; font-size: 12px; color: var(--dim); border-bottom: 1px solid var(--line); display: flex; gap: 10px; flex-wrap: wrap; }
  .hits { list-style: none; padding: 0; margin: 0; }
  .hit { display: grid; grid-template-columns: 22px 1fr; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .hit.sel { background: var(--panel); }
  .src { font-size: 12px; color: var(--dim); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .src b { color: var(--text); font-weight: 600; }
  .hit p { margin: 4px 0 0; }
  mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; }
  .xp-foot { position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--line); background: var(--sunk); margin-top: auto; }
  .books { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .books li { display: flex; align-items: center; gap: 8px; }
  .books .n { margin-left: auto; color: var(--dim); font-size: 12px; }
  .empty { padding: 24px 14px; color: var(--dim); }
  @media (max-width: 640px) { .xp { grid-template-columns: 1fr; } .xp-side { border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
<div class="xp">
  <aside class="xp-side" aria-label="Filters">
    <div class="field"><span class="label" id="m-l">Match</span>
      <div class="chips" role="radiogroup" aria-labelledby="m-l" id="modes"></div></div>
    ${withYears ? `<div class="field"><label class="label" for="yr">Published before</label>
      <div class="select-wrap"><select class="select" id="yr"><option value="">Any year</option><option value="1820">1820</option><option value="1860">1860</option><option value="1900">1900</option></select><span class="i i-down"></span></div></div>` : ''}
    <div class="field"><span class="label">Books with matches</span><ul class="books" id="books"></ul></div>
  </aside>
  <div class="xp-main">
    <form class="xp-search" id="f" role="search">
      <input class="input" id="q" aria-label="Search the corpus" autocomplete="off">
      <button class="btn" type="submit">Search</button>
    </form>
    <div class="xp-status" id="status" role="status"></div>
    <ul class="hits" id="hits"></ul>
    <div class="xp-foot"><span class="small dim grow" id="count">Nothing selected</span><button class="btn send" id="send" disabled>Send passages</button></div>
  </div>
</div>
<script>
  const S = { q: 'hope after loss', mode: 'both', picked: {}, year: '', results: [] };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function modes() {
    $('modes').innerHTML = ['both', 'lexical', 'semantic'].map((m) =>
      '<button type="button" class="chip sm' + (S.mode === m ? ' on' : '') + '" role="radio" aria-checked="' + (S.mode === m) + '" data-m="' + m + '">' + m[0].toUpperCase() + m.slice(1) + '</button>').join('');
  }
  function highlight(text, terms) {
    let out = esc(text);
    for (const t of terms || []) out = out.replace(new RegExp('\\\\b(' + t + '\\\\w*)', 'gi'), '<mark>$1</mark>');
    return out;
  }
  function render() {
    modes();
    let rows = S.results;
    if (S.year) rows = rows.filter((r) => r.year && r.year < +S.year);
    const byBook = {};
    for (const r of rows) byBook[r.title] = (byBook[r.title] || 0) + 1;
    $('books').innerHTML = Object.entries(byBook).map(([b, n]) => '<li><i>' + esc(b) + '</i><span class="n">' + n + '</span></li>').join('') || '<li class="dim">None yet</li>';
    $('status').textContent = rows.length + ' passages · semantic scores come from a stub until your index is connected';
    $('hits').innerHTML = rows.length ? rows.map((r, i) => {
      const on = !!S.picked[r.id];
      const pills = (r.lexical ? '<span class="pill">lexical · BM25 ' + r.lexical.score + '</span>' : '') + (r.semantic !== null && r.semantic !== undefined ? '<span class="pill">semantic · ' + r.semantic.toFixed(2) + '</span>' : '');
      return '<li class="hit' + (on ? ' sel' : '') + '" data-anchor="' + (i === 1 ? 'result row 2' : '') + '">' +
        '<span class="check" role="checkbox" tabindex="0" aria-checked="' + on + '" aria-label="Select passage from ' + esc(r.title) + ', ' + esc(r.chapter) + '" data-id="' + esc(r.id) + '"><span class="box"></span></span>' +
        '<div><div class="src"><b><i>' + esc(r.title) + '</i></b> · ' + esc(r.chapter) + pills + '</div><p>' + highlight(r.text.length > 420 ? r.text.slice(0, 420) + '…' : r.text, r.lexical && r.lexical.terms) + '</p></div></li>';
    }).join('') : '<li class="empty">No passages match. Try other words, or switch to Semantic.</li>';
    const n = Object.keys(S.picked).length;
    $('count').textContent = n ? n + ' selected' : 'Nothing selected';
    $('send').textContent = n ? 'Send ' + n + ' passage' + (n === 1 ? '' : 's') + ' to @librarian' : 'Send passages';
    $('send').disabled = !n;
    postbox.anchors({ 'search box': $('f'), 'send button': $('send'), 'result row 2': document.querySelector('[data-anchor="result row 2"]') });
  }
  async function run() {
    $('status').textContent = 'Searching…';
    try { S.results = await postbox.query('corpus.search', { query: S.q, mode: S.mode, k: 12 }); }
    catch (e) { S.results = []; $('status').textContent = e.message; return; }
    render();
  }
  function toggle(id) {
    const r = S.results.find((x) => x.id === id);
    if (S.picked[id]) delete S.picked[id]; else S.picked[id] = { title: r.title, chapter: r.chapter };
    postbox.saveState({ q: S.q, mode: S.mode, picked: S.picked, year: S.year });
    render();
    const el = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (el) el.focus();
  }
  document.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { S.mode = m.dataset.m; postbox.saveState({ q: S.q, mode: S.mode, picked: S.picked, year: S.year }); run(); return; }
    const c = e.target.closest('[data-id]');
    if (c) toggle(c.dataset.id);
  });
  document.addEventListener('keydown', (e) => { const c = e.target.closest && e.target.closest('[data-id]'); if (c && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggle(c.dataset.id); } });
  $('f').addEventListener('submit', (e) => { e.preventDefault(); S.q = $('q').value; postbox.saveState({ q: S.q, mode: S.mode, picked: S.picked, year: S.year }); run(); });
  ${withYears ? `$('yr').addEventListener('change', (e) => { S.year = e.target.value; postbox.saveState({ q: S.q, mode: S.mode, picked: S.picked, year: S.year }); render(); });` : ''}
  $('send').addEventListener('click', () => {
    const picked = Object.entries(S.picked);
    const books = {};
    for (const [, p] of picked) books[p.title] = (books[p.title] || 0) + 1;
    const summary = picked.length + ' passage' + (picked.length === 1 ? '' : 's') + ' · ' + Object.entries(books).map(([b, n]) => b + (n > 1 ? ' (' + n + ')' : '')).join(', ');
    postbox.send('use-passages', { passages: picked.map(([id]) => id) }, summary);
  });
  postbox.ready.then(({ state }) => {
    if (state) Object.assign(S, state);
    $('q').value = S.q;
    ${withYears ? `$('yr').value = S.year || '';` : ''}
    run();
  });
</script>`;

export const practiceApp = () => `
<style>
  .practice { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
  .trace { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .trace li { display: grid; grid-template-columns: 110px 1fr; gap: 10px; padding: 6px 10px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
  .opt { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 22px 1fr; gap: 8px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); }
  .opt:hover, .opt[aria-checked="true"] { border-color: var(--accent); }
  .opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dot { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--dim); margin-top: 1px; display: grid; place-items: center; }
  .opt[aria-checked="true"] .dot { border-color: var(--on); background: var(--on); }
  .opt[aria-checked="true"] .dot::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--on-ink); }
  .feedback { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-left: 3px solid var(--good); border-radius: 6px; background: var(--panel); font-size: 13px; }
  .feedback.wrong { border-left-color: var(--alert); }
  .pips { display: flex; gap: 4px; } .pips i { width: 18px; height: 4px; border-radius: 999px; background: var(--line); } .pips i.on { background: var(--accent); }
  @media (max-width: 520px) { .trace li { grid-template-columns: 1fr; gap: 2px; } }
</style>
<div class="practice">
  <div class="pips" aria-hidden="true" id="pips"></div>
  <ol class="trace" id="trace"></ol>
  <div class="options" role="radiogroup" aria-label="Next step" id="opts" style="display:flex;flex-direction:column;gap:8px"></div>
  <div id="fb" role="status"></div>
  <div class="row-flex"><button class="btn" id="next">Next exercise</button><button class="btn ghost" id="stuck">Tell @researcher I’m stuck</button></div>
</div>
<script>
  const EX = [
    { trace: [['Question', 'Which is older, <i>Persuasion</i> or <i>Middlemarch</i>?'], ['Thought 1', 'I need both publication years.']],
      opts: ['<b>Action 1:</b> look up both books at once', '<b>Action 1:</b> <code>corpus.lookup("Persuasion")</code>', '<b>Answer now:</b> “<i>Middlemarch</i> is older.”'], right: 1,
      why: 'One lookup per action keeps each observation clear. Guessing skips the evidence entirely.' },
    { trace: [['Question', 'Which is older, <i>Persuasion</i> or <i>Middlemarch</i>?'], ['Thought 1', 'I need both publication years.'], ['Action 1', '<code>corpus.lookup("Persuasion")</code>'], ['Observation 1', 'Published 1817.']],
      opts: ['<b>Answer now:</b> “<i>Persuasion</i> is older.”', '<b>Thought 2:</b> “I still need the year for <i>Middlemarch</i>,” then look it up.', '<b>Action 2:</b> search the web for “older novel”.'], right: 1,
      why: 'One year can’t settle a comparison, so the next thought names the missing fact before acting. Answering now would be a guess that happens to be correct.' },
  ];
  let S = { i: 0, pick: null };
  const $ = (id) => document.getElementById(id);
  function render() {
    const ex = EX[S.i];
    $('pips').innerHTML = EX.map((_, k) => '<i class="' + (k <= S.i ? 'on' : '') + '"></i>').join('') + '<i></i><i></i>';
    $('trace').innerHTML = ex.trace.map(([k, v]) => '<li><span class="label">' + k + '</span><span>' + v + '</span></li>').join('');
    $('opts').innerHTML = ex.opts.map((o, k) => '<button class="opt" role="radio" aria-checked="' + (S.pick === k) + '" data-k="' + k + '"><span class="dot"></span><span>' + o + '</span></button>').join('');
    $('fb').innerHTML = S.pick === null ? '' : '<div class="feedback' + (S.pick === ex.right ? '' : ' wrong') + '"><span>' + (S.pick === ex.right ? '<b>Right.</b> ' : '<b>Not quite.</b> ') + ex.why + '</span></div>';
    $('next').disabled = S.i >= EX.length - 1;
  }
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-k]');
    if (o) { S.pick = +o.dataset.k; postbox.saveState(S); render(); document.querySelector('[data-k="' + S.pick + '"]').focus(); }
  });
  $('next').addEventListener('click', () => { S = { i: Math.min(S.i + 1, EX.length - 1), pick: null }; postbox.saveState(S); render(); });
  $('stuck').addEventListener('click', () => postbox.send('stuck', { exercise: S.i + 1 }, 'I’m stuck on exercise ' + (S.i + 1)));
  postbox.ready.then(({ state }) => { if (state) S = state; else S = { i: 1, pick: 1 }; render(); });
</script>`;

// A dashboard built from the kit’s chart helpers. Version 1 has a wide fixed-width table that overflows
// at phone width, so the pre-display check catches it; version 2 fixes it.
export const dashboardApp = ({ fixed = false } = {}) => `
<style>
  .dash { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 14px; }
  .dash .full { grid-column: 1 / -1; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0; }
  .card h2 { font-size: 14px; margin: 0 0 8px; }
  ${fixed ? '' : '.wide { width: 980px; }'}
  @media (max-width: 720px) { .dash { grid-template-columns: minmax(0, 1fr); } }
</style>
<div class="dash">
  <section class="card full"><h2>Passages per book</h2><div id="bars"></div></section>
  <section class="card"><h2>How passages matched</h2><div id="scatter"></div></section>
  <section class="card"><h2>Themes by book</h2><div id="heat"></div></section>
  <section class="card full wide"><h2>Index runs</h2><div id="table"></div></section>
</div>
<script>
  postbox.ready.then(async () => {
    const stats = await postbox.query('corpus.stats', {});
    postbox.charts.stacked(document.getElementById('bars'), {
      label: 'Passages per book', categories: stats.books.map((b) => b.title),
      series: [{ name: 'Passages', values: stats.books.map((b) => b.passages) }], percent: false });
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pts = (n, x0, x1, y0, y1) => Array.from({ length: n }, () => [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)]);
    postbox.charts.scatter(document.getElementById('scatter'), { x: 'BM25 score', y: 'Semantic score', xMax: 10, yMax: 1,
      groups: [{ name: 'Both', points: pts(12, 5, 9, 0.6, 0.85) }, { name: 'Lexical only', points: pts(12, 4, 9, 0.15, 0.45) }, { name: 'Semantic only', points: pts(12, 0.3, 3, 0.55, 0.85) }] });
    postbox.charts.heatmap(document.getElementById('heat'), { rows: ['Middlemarch', 'Persuasion', 'Emma', 'Moby-Dick', 'Walden', 'Dubliners'], cols: ['Grief', 'Hope', 'Money', 'The sea'],
      values: [[64, 51, 88, 4], [38, 72, 41, 47], [12, 33, 52, 2], [41, 18, 22, 118], [9, 44, 61, 31], [83, 15, 27, 6]] });
    postbox.charts.table(document.getElementById('table'), { columns: ['Run', 'Books', 'Passages', 'Time'], rows: [['Lexical index', 6, stats.passages.toLocaleString('en-US'), '1.2 s'], ['Semantic stub', 6, stats.passages.toLocaleString('en-US'), '0.3 s']] });
  });
</script>`;

// An app with a bug: it reads a property of undefined after load. The sandbox catches the error and
// Postbox shows a “stopped working” card instead of a broken frame.
export const brokenMapApp = () => `
<div class="pad" style="padding:14px"><p>Loading the shelf map…</p><div id="map"></div></div>
<script>
  postbox.ready.then(async () => {
    const stats = await postbox.query('corpus.stats', {});
    const rows = stats.rows; // the agent misremembered the shape: it’s stats.books
    document.getElementById('map').textContent = rows.map((r) => r.title).join(', ');
  });
</script>`;

// The layout @critic proposes, shown as an app so you can review it with pinned comments.
export const layoutApp = () => `
<style>
  .mini { padding: 18px 14px 14px; display: flex; flex-direction: column; gap: 14px; }
  .mini .r { display: grid; grid-template-columns: 1fr; gap: 4px; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
</style>
<div class="mini">
  <div id="search" style="display:flex;gap:8px;align-items:center"><input class="input" value="hope after loss" aria-label="Search"><button class="btn">Search</button></div>
  <div class="r"><div class="small dim"><b style="color:var(--text)"><i>Persuasion</i></b> · ch. 23 <span class="pill">lexical · BM25 8.4</span></div><p style="margin:0">…loving longest, when existence or when <mark style="background:var(--mark);color:inherit">hope</mark> is gone.</p></div>
  <div class="r" id="row2"><div class="small dim"><b style="color:var(--text)"><i>Middlemarch</i></b> · ch. 20 <span class="pill">semantic · 0.66</span></div><p style="margin:0">…that roar which lies on the other side of silence.</p></div>
  <div id="sendrow" style="display:flex;justify-content:flex-end"><button class="btn send">Send 2 passages</button></div>
</div>
<script>
  postbox.ready.then(() => postbox.anchors({ 'search box': document.getElementById('search'), 'result row 2': document.getElementById('row2'), 'send button': document.getElementById('sendrow') }));
</script>`;
