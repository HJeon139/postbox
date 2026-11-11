// The demo’s client of Postbox’s public API (tools/demo.mjs): its calls, with the page’s token for a write, and its
// reads of the state, which a scene waits on.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The page’s token, as the cookie header a write needs (#74). The server gives it to a browser that opens `/`, so
 * this tool, which is the person’s own, opens `/` the way a browser does, with a navigation’s Fetch Metadata headers.
 * @param {string} origin
 */
export async function pageCookie(origin) {
  const r = await fetch(`${origin}/`, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' } });
  await r.arrayBuffer();
  const set = r.headers.get('set-cookie') ?? '';
  if (!/^pb_token_\d+=/.test(set)) throw new Error(`${origin}/ didn’t set the page’s token. Is it a Postbox server?`);
  return set.split(';')[0];
}

export function client(origin) {
  let cookie = null;
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    if (method !== 'GET') cookie ??= await pageCookie(origin);
    const r = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...(method !== 'GET' && cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path}: ${data.error ?? r.status}`);
    return data;
  };
  const state = async () => (await call('/api/state')).state;
  const until = async (fn, { timeout = 30000, label = 'the next step' } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const s = await state();
      const v = fn(s);
      if (v) return v;
      await sleep(200);
    }
    const st = await state();
    const apps = Object.values(st.apps)
      .map((x) => `${x.id} v${x.current} ${x.check.status}${x.check.problems.length ? ' (' + x.check.problems.map((p) => p.code).join(', ') + ')' : ''}`)
      .join('; ');
    throw new Error(`Timed out waiting for ${label}.${apps ? ` Apps: ${apps}.` : ''}`);
  };
  const thread = (s, title) => Object.values(s.threads).find((t) => t.title === title);
  const items = (s, t) => s.items[t.id] ?? [];
  const session = (s, t, handle) => (t.members ?? []).map((id) => s.sessions[id]).find((x) => x?.handle === handle);
  const idle = (s, t) => (t.members ?? []).every((id) => !['think', 'gen', 'tool'].includes(s.sessions[id]?.state));
  return { call, state, until, thread, items, session, idle };
}
