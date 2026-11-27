// Inlined after the kit in every app page: postbox.narrate and postbox.narration, moved out of kit.js as a concern of
// their own. They reach Postbox only through postbox.query, and the kit’s resize observer sizes the frame to the player.
// A block, not a function, keeps its names out of the app’s page, so each is a const: a function declared in a block
// would still reach the page’s global names.

{
  // Needs the narrate.speak permission (and its agent needs the tool). Audio is made on the host by a local
  // Kokoro voice, one passage at a time, and only when you press Play, so the pre-display check makes none.
  const clipCache = new Map();
  const narrate = async (text, opts = {}) => {
    const key = `${opts.voice || ''}|${opts.speed || 1}|${text}`;
    if (!clipCache.has(key)) {
      clipCache.set(
        key,
        window.postbox.query('narrate.speak', { text, voice: opts.voice, speed: opts.speed }).then((r) => {
          const bytes = Uint8Array.from(atob(r.wav), (c) => c.charCodeAt(0));
          return { url: URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), ms: r.ms };
        }),
      );
      clipCache.get(key).catch(() => clipCache.delete(key));
    }
    return clipCache.get(key);
  };
  {
    // The player’s styles, once a page.
    const st = document.createElement('style');
    st.textContent = `.pb-narr{display:flex;flex-direction:column;gap:10px}.pb-narr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .pb-narr-status{font-size:12px;color:var(--dim)}.pb-narr ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
      .pb-narr li button{all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 10px;border-radius:6px;border-left:3px solid transparent;color:var(--dim);cursor:pointer;line-height:1.45}
      .pb-narr li button:hover{background:var(--chip)}.pb-narr li button:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:1px}
      .pb-narr li button[aria-current="true"]{color:var(--text);background:var(--sunk);border-left-color:var(--accent)}`;
    document.head.appendChild(st);
  }
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  /** The player’s bar (Play and its status) and its transcript, one button a passage, which plays from it. */
  const playerView = (list, label, onPick) => {
    const root = make('div', 'pb-narr');
    const bar = make('div', 'pb-narr-bar');
    const btn = make('button', 'btn', 'Play');
    btn.type = 'button';
    const status = make('span', 'pb-narr-status', `${list.length} passage${list.length === 1 ? '' : 's'} · read aloud by a local voice`);
    status.setAttribute('role', 'status');
    bar.append(btn, status);
    const ol = make('ol');
    ol.setAttribute('aria-label', label || 'Transcript');
    const items = list.map((p, i) => {
      const li = make('li');
      const b = make('button', null, p.text);
      b.type = 'button';
      b.addEventListener('click', () => onPick(i));
      li.append(b);
      ol.append(li);
      return b;
    });
    root.append(bar, ol);
    const mark = (i) => {
      items.forEach((b, j) => {
        if (j === i) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
    };
    return { root, btn, status, mark };
  };
  const narration = (el, passages, opts = {}) => {
    const list = (passages || []).map((p, i) =>
      typeof p === 'string' ? { id: `p${i + 1}`, text: p } : { id: p.id || `p${i + 1}`, text: String(p.text || '') },
    );
    const { root, btn, status, mark } = playerView(list, opts.label, (i) => play(i));
    el.replaceChildren(root);
    const audio = new Audio();
    let at = -1;
    let playing = false;
    async function play(i = Math.max(at, 0)) {
      if (i >= list.length) return stop(true);
      at = i;
      playing = true;
      btn.textContent = 'Pause';
      mark(i);
      opts.onPassage?.(i, list[i]);
      status.textContent = `Preparing passage ${i + 1} of ${list.length}…`;
      try {
        const clip = await narrate(list[i].text, opts);
        if (!playing || at !== i) return;
        audio.src = clip.url;
        await audio.play();
        status.textContent = `Reading passage ${i + 1} of ${list.length}`;
        if (i + 1 < list.length) narrate(list[i + 1].text, opts).catch(() => {});
      } catch (e) {
        playing = false;
        btn.textContent = 'Play';
        status.textContent = `The voice isn’t available: ${e.message || e}. The transcript is all here.`;
      }
    }
    function stop(finished) {
      playing = false;
      audio.pause();
      btn.textContent = finished ? 'Play again' : 'Play';
      status.textContent = finished ? 'Finished.' : `Paused at passage ${at + 1} of ${list.length}`;
      if (finished) at = -1;
    }
    audio.addEventListener('ended', () => play(at + 1));
    btn.addEventListener('click', () => (playing ? stop(false) : play()));
    return {
      play,
      pause: () => stop(false),
      get index() {
        return at;
      },
    };
  };
  window.postbox.narrate = narrate;
  window.postbox.narration = narration;
}
