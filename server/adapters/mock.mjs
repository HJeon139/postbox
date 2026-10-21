// The mock agent: a scripted stand-in for a real model, so Postbox runs offline and the demo can show
// every block and every error state on demand. It uses the same adapter interface a real model will.
//
// Each persona has scripts chosen by keywords in your message (see SCRIPTS below) and handlers for the
// events it receives: your block answers, app events, wake-ups, lint results and failed app checks.

import { brokenMapApp, dashboardApp, explorerApp, layoutApp, practiceApp, walkthroughApp } from '../mock/apps.mjs';

// POSTBOX_MOCK_SPEED scales every pause: 1 is a natural pace, 0.2 is fast. It’s read on each pause, so a demo can change it.
const speed = () => Number(process.env.POSTBOX_MOCK_SPEED ?? 1);

export class MockAdapter {
  name = 'mock';
  constructor() {
    this.memory = new Map();
  }

  async deliver(session, message, ctx) {
    const mem = this.memory.get(session.id) ?? {};
    this.memory.set(session.id, mem);
    ctx.checkpoint?.({ mock: session.id });
    const a = kit(ctx, session, mem);
    // In a topic thread, any mock agent answers the side question and can summarize it back.
    if (message.context?.some((c) => c.includes('This is a topic thread'))) mem.topic = true;
    if (mem.topic && message.kind === 'notice' && /Summarize this topic thread/.test(message.text)) await topicSummary(a);
    else if (mem.topic && message.kind === 'user') await topicReply(a);
    else await (HANDLERS[session.handle] ?? HANDLERS.default)(message, a, mem, session);
    a.grow(message);
  }

  /** A topic thread’s fork starts with what the conversation’s session remembered. */
  fork(source, target) {
    try {
      this.memory.set(target.id, structuredClone(this.memory.get(source.id) ?? {}));
    } catch {
      this.memory.set(target.id, {});
    }
  }

  dispose(session) {
    this.memory.delete(session.id);
  }
}

function kit(ctx, session, mem) {
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      if (ctx.signal.aborted) return reject(abortError());
      const t = setTimeout(resolve, ms * speed());
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(abortError());
        },
        { once: true },
      );
    });
  let n = 0;
  mem.ctx ??= session.ctx ?? 4;
  return {
    sleep,
    async think(ms = 700) {
      ctx.status({ state: 'think' });
      await sleep(ms);
    },
    async say(text, { cps = 260 } = {}) {
      // Stream a few words at a time, the way a model does.
      const parts = text.match(/\S+\s*|\s+/g) ?? [];
      for (let i = 0; i < parts.length; i += 3) {
        const chunk = parts.slice(i, i + 3).join('');
        ctx.text(chunk);
        await sleep((chunk.length / cps) * 1000);
      }
    },
    async tool(label, ms = 500, { fail = false } = {}) {
      const id = `t${++n}`;
      ctx.activity({ id, label, state: 'running' });
      await sleep(ms);
      ctx.activity({ id, label, state: fail ? 'failed' : 'done', ms });
    },
    status: (p) => ctx.status(p),
    /** Asks you, as a real agent in “ask” mode does before a risky tool call. */
    ask: (req) => ctx.askPermission(req),
    ctxTo(pct) {
      mem.ctx = pct;
      ctx.status({ ctx: pct });
    },
    grow(message) {
      mem.ctx = Math.min(96, mem.ctx + Math.max(1, Math.round(JSON.stringify(message).length / 400)));
      ctx.status({ ctx: mem.ctx });
    },
    sources: (list) => ctx.sources(list),
    compaction: (c) => ctx.compaction(c),
    t: ctx.tools,
    block(b) {
      return ctx.tools.show_block({ block: { version: 1, ...b } });
    },
    update(b) {
      return ctx.tools.update_block({ block: { version: 1, ...b } });
    },
  };
}

function abortError() {
  return Object.assign(new Error('Stopped'), { name: 'AbortError' });
}
const has = (text, re) => re.test(String(text ?? '').toLowerCase());

// ── Persona scripts ─────────────────────────────────────────────────────────────────────

const HANDLERS = {
  async librarian(m, a, mem) {
    if (m.kind === 'event') return librarianEvent(m.event, a, mem);
    if (m.kind === 'lint') return defineAll(m, a);
    if (m.kind === 'app-check') return;
    if (m.kind === 'agent') {
      await a.think(300);
      return a.say(`Thanks ${m.from}, noted.`);
    }
    const text = m.text ?? m.note ?? '';
    if (has(text, /every (kind of )?block|catalog|tour/)) return catalogTour(a);
    if (has(text, /explor|search|corpus|passage/)) return corpusExplorer(a, mem);
    await a.think(500);
    await a.say(
      'I can build you an explorer for your books, walk you through every block I can send, or answer questions about the corpus. Try “Build me an explorer for my corpus”.',
    );
  },

  async researcher(m, a, mem) {
    if (m.kind === 'lint') return defineAll(m, a);
    if (m.kind === 'event') {
      if (m.event.action === 'stuck') {
        await a.think(400);
        return a.say(
          'No problem. The trick in exercise 2 is that one observation only tells you half of the comparison. Before acting, name what’s still missing: *“I still need the year for Middlemarch.”* Then the next action follows from that thought.',
        );
      }
      const chosen = m.event.values?.selected ?? [];
      await a.think(600);
      return a.say(
        `Good choice. I’ll start with ${chosen.length > 1 ? `**${chosen.length} papers**` : 'that paper'} and keep each walkthrough short, with an exercise at the end. Ask me to “explain ReAct” whenever you’re ready.`,
      );
    }
    if (m.kind === 'agent') return researcherReply(m, a, mem);
    const text = m.text ?? '';
    if (has(text, /edition/)) {
      await a.tool('read books/manifest.json', 400);
      return a.say(
        'All six books are Project Gutenberg plain-text editions. Three have more than one edition in the folder, so we should pick one each:\n\n- *Middlemarch*: keep the 1874 one-volume text; drop the serial parts.\n- *Emma* and *Persuasion*: keep the editions with chapter headings intact.\n\nPlain text has no page numbers, so I suggest we keep **chapter and character offsets** per passage instead. They survive re-chunking.',
      );
    }
    if (has(text, /walk me through|out loud|narrat/)) return walkthrough(a);
    if (has(text, /explain|react|reason/)) return explainer(a, mem);
    if (has(text, /paper|memory|read/)) return paperChoice(a);
    await a.think(500);
    await a.say('I read papers and turn them into step-by-step explainers with exercises. Try “Explain ReAct with something I can try”.');
  },

  async indexer(m, a, mem, _se) {
    if (m.kind === 'lint') return defineAll(m, a);
    if (m.kind === 'app-check') return fixApp(m, a);
    if (m.kind === 'event') {
      if (m.event.blockId === 'dupes') {
        await a.tool('corpus.remove 14 passages', 600);
        return a.say(
          m.event.action === 'confirm' ? 'Removed the 14 duplicate passages from both indexes. The source files are untouched.' : 'Kept them. Nothing changed.',
        );
      }
      return a.say('Noted.');
    }
    if (m.kind === 'wake') {
      await a.tool('index.status', 400);
      return a.say(`I’m back, as planned (“${m.note}”). The embedding run finished cleanly, and every sample query returned results.`);
    }
    if (m.kind === 'agent') return indexerReply(m, a, mem);
    if (m.kind === 'notice') {
      await a.think(300);
      return a.say('Understood. I’ll carry on without that.');
    }
    const text = m.text ?? '';
    if (m.retry) {
      await a.think(500);
      return a.say(
        'Retrying. This time the model answered: the BM25 index for *Middlemarch*, *Emma* and *Persuasion* is rebuilt without prefaces, and the embeddings are queued.',
      );
    }
    if (has(text, /fail|preface|rebuild/)) return failingReply(a);
    if (has(text, /cache|clean/)) return cleanCache(a);
    if (has(text, /timeline|broken|invalid/)) return brokenBlocks(a);
    if (has(text, /map/)) return brokenMap(a, mem);
    if (has(text, /dashboard|chart/)) return dashboard(a, mem);
    if (has(text, /quote|citation|teammate/)) return proposeCiter(a);
    if (has(text, /later|schedule|remind/)) return scheduleLater(a);
    if (has(text, /ping|loop|edition/)) return askResearcher(a);
    if (has(text, /duplicate|dupes|remove/)) return confirmDupes(a);
    if (has(text, /caption/)) {
      await a.tool('grep “[Illustration” books/*.txt', 400);
      return a.say('Done: illustration captions are dropped from both indexes. That removed 212 passages, mostly from *Emma* and *Moby-Dick*.');
    }
    if (has(text, /index|build|shelf|embed/)) return indexShelf(a, mem);
    await a.think(400);
    await a.say('I build and maintain the search indexes. Try “Index the shelf”, “Show me a dashboard”, or “Rebuild without the prefaces”.');
  },

  async critic(m, a, mem) {
    if (m.kind === 'lint') return defineAll(m, a);
    if (m.kind === 'event') return criticRevise(m.event, a, mem);
    if (m.kind === 'app-check') return;
    if (m.kind === 'agent') {
      await a.think(300);
      return a.say(`Thanks ${m.from}, noted.`);
    }
    const text = m.text ?? '';
    if (has(text, /review|spec|schema|layout/)) return criticReview(a, mem);
    await a.think(400);
    await a.say('Send me a spec, some code or a layout and I’ll review it with you line by line. Try “Review my corpus schema”.');
  },

  async default(m, a) {
    if (m.kind === 'lint') return defineAll(m, a);
    await a.think(500);
    await a.say(
      m.kind === 'agent'
        ? `Thanks ${m.from}. I’ve noted that.`
        : 'I’m a new agent running on the mock backend, so my replies are scripted. To use a real model, pick Claude Code or the Agent SDK for an agent in the new-agent sheet.',
    );
  },
};

async function defineAll(m, a) {
  // The linter found terms this agent used but never defined; define them quietly.
  const known = {
    'observation-budget':
      'A cap on how many tool observations an agent keeps in full before summarizing older ones, so long runs don’t fill the context window.',
    'context-compaction':
      'Summarizing an agent’s older context so a long run fits its context window. Postbox shows each compaction as a divider you can expand.',
  };
  for (const t of m.undefinedTerms) {
    await a.sleep(150);
    a.t.define_term({ term: t.term, key: t.key, definition: known[t.key] ?? `${t.term}: a name used in this thread for a specific step or requirement.` });
  }
}

// ── @librarian ───────────────────────────────────────────────────────────────────────────

async function corpusExplorer(a, mem) {
  await a.think(700);
  await a.tool('corpus.stats', 300);
  await a.tool('corpus.search “hope after loss”', 400);
  await a.say(
    'Here’s an explorer over all six books in your corpus. It runs two searches at once, **lexical** (BM25, exact words) and **semantic** (meaning, from a stub until your own index is connected), and labels which one found each passage. Tick the passages you want and send them back to me.',
  );
  a.t.show_app({
    id: 'corpus-explorer',
    title: 'Corpus explorer',
    code: explorerApp(),
    permissions: ['corpus.search', 'corpus.stats'],
    fallback: 'Corpus explorer: an interactive search across your books. Open Postbox to use it.',
  });
  mem.explorer = 1;
}

async function librarianEvent(ev, a, _mem) {
  if (ev.blockId === 'corpus-explorer' && ev.action === 'use-passages') {
    await a.think(800);
    await a.tool(`corpus.read ${ev.values.passages.length} passages`, 500);
    await a.say(
      'Good picks. Some came from exact matches on your words, and at least one surfaced only through meaning, which suggests the idea runs wider than the vocabulary you searched with.\n\nI’ve added a filter for publication year in **v2**, so you can see whether the theme shifts over the century.',
    );
    a.t.update_app({ id: 'corpus-explorer', code: explorerApp({ withYears: true }), summary: 'adds a publication-year filter' });
    return;
  }
  await a.think(500);
  const replies = {
    'start-book': 'Noted. I’ll plan around that book first.',
    'passage-kinds': 'Got it. I’ll weight those kinds of passage when I suggest readings.',
    plan: 'Saved your reading plan. I’ll send the first session on the start date.',
    'title-pages': 'Retrying the one that failed.',
    'book-card': 'On it.',
    'letter-table': 'Opening that passage in the explorer.',
  };
  await a.say(replies[ev.blockId] ?? 'Noted.');
}

async function catalogTour(a) {
  await a.think(600);
  await a.say('Here’s one of each block in the catalog. Everything below is live: answer any of them and I’ll get the event.');
  a.block({
    id: 'start-book',
    type: 'choice',
    title: 'Which book should we start with?',
    fallback: 'Which book should we start with: Middlemarch, Persuasion or Walden? Reply in the chat.',
    options: [
      { id: 'middlemarch', label: 'Middlemarch' },
      { id: 'persuasion', label: 'Persuasion' },
      { id: 'walden', label: 'Walden' },
    ],
    other: { label: 'Something else', placeholder: 'Another book' },
  });
  await a.sleep(250);
  a.block({
    id: 'passage-kinds',
    type: 'choice',
    title: 'Which kinds of passage interest you?',
    fallback: 'Which kinds of passage interest you: letters, dialogue, landscape, endings or openings?',
    multiple: true,
    max: 3,
    options: [
      { id: 'letters', label: 'Letters' },
      { id: 'dialogue', label: 'Dialogue' },
      { id: 'landscape', label: 'Landscape' },
      { id: 'endings', label: 'Endings' },
      { id: 'openings', label: 'Openings' },
    ],
  });
  await a.sleep(250);
  a.block({
    id: 'plan',
    type: 'form',
    title: 'Set up your reading plan',
    fallback: 'Tell me a plan name, pages per day (5–200), a pace, a start date, and whether you want reminders.',
    submitLabel: 'Save plan',
    fields: [
      { id: 'name', label: 'Plan name', kind: 'text', required: true, placeholder: 'Autumn with Eliot' },
      { id: 'pages', label: 'Pages per day', kind: 'number', min: 5, max: 200, required: true },
      {
        id: 'pace',
        label: 'Pace',
        kind: 'select',
        options: [
          { id: 'steady', label: 'Steady' },
          { id: 'sprint', label: 'Sprint' },
          { id: 'slow', label: 'Slow and close' },
        ],
        default: 'steady',
      },
      { id: 'start', label: 'Start date', kind: 'date', help: 'Your first reading day' },
      { id: 'remind', label: 'Remind me on the morning of each session', kind: 'toggle', default: true },
      { id: 'notes', label: 'Anything else?', kind: 'longtext', maxLength: 2000, help: 'Optional. Markdown is fine.' },
    ],
  });
  await a.sleep(250);
  const books = ['Middlemarch', 'Persuasion', 'Emma', 'Walden', 'Moby-Dick', 'Dubliners'];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  a.block({
    id: 'letter-table',
    type: 'table',
    title: 'Passages that mention a letter',
    fallback: '200 passages that mention a letter, highest score first. Ask me for the list as text.',
    columns: [
      { id: 'book', label: 'Book', sortable: true },
      { id: 'chapter', label: 'Chapter', kind: 'number', sortable: true },
      { id: 'words', label: 'Words', kind: 'number', sortable: true },
      { id: 'score', label: 'Score', kind: 'number', sortable: true },
    ],
    rows: Array.from({ length: 200 }, (_, i) => ({
      id: `r${i + 1}`,
      cells: {
        book: books[Math.floor(rnd() * books.length)],
        chapter: 1 + Math.floor(rnd() * 60),
        words: 120 + Math.floor(rnd() * 900),
        score: +(9.6 - i * 0.041).toFixed(2),
      },
    })),
    rowAction: { id: 'open', label: 'Open' },
  });
  await a.sleep(250);
  const steps = ['Middlemarch', 'Persuasion', 'Walden', 'Moby-Dick', 'Emma'];
  const prog = (states, _detail) => ({
    id: 'title-pages',
    type: 'progress',
    title: 'Fetch title pages',
    fallback: 'Fetching title pages for five books.',
    steps: steps.map((s, i) => ({
      id: `s${i}`,
      label: s,
      state: states[i],
      ...(states[i] === 'failed' ? { detail: 'That address isn’t on the allowed list, so I skipped it.' } : {}),
      ...(states[i] === 'done' ? { duration: `${(0.8 + i * 0.1).toFixed(1)} s` } : {}),
    })),
  });
  a.block(prog(['running', 'pending', 'pending', 'pending', 'pending']));
  await a.sleep(250);
  a.block({
    id: 'book-card',
    type: 'card',
    title: 'Middlemarch',
    fallback: 'Middlemarch, by George Eliot (1871–72): 2,514 passages, indexed today.',
    facts: [
      { label: 'Author', value: 'George Eliot' },
      { label: 'Published', value: '1871–72, in eight parts' },
      { label: 'Passages', value: '2,514' },
      { label: 'Indexed', value: 'Today' },
    ],
    actions: [
      { id: 'open', label: 'Open in explorer' },
      { id: 'reindex', label: 'Re-index' },
      { id: 'chapters', label: 'Show chapters' },
    ],
  });
  await a.sleep(250);
  a.block({
    id: 'dupes-tour',
    type: 'confirm',
    title: 'Remove 14 duplicate passages?',
    fallback: 'I can remove 14 duplicate passages from the index. Reply “yes” to remove them.',
    statement:
      'This deletes 14 passages from both the lexical and semantic indexes. The source books in `~/books` aren’t touched, and **Re-index** brings the passages back.',
    confirmLabel: 'Remove 14 passages',
    cancelLabel: 'Keep them',
  });
  await a.sleep(250);
  a.block({
    id: 'title-page',
    type: 'image',
    title: 'Title page, first edition',
    fallback: 'The title page of Middlemarch, book one, 1871.',
    src: `${process.env.POSTBOX_ORIGIN ?? 'http://127.0.0.1:4173'}/media/middlemarch-title.svg`,
    alt: 'The title page of Middlemarch: A Study of Provincial Life, by George Eliot, book one, published by William Blackwood and Sons in 1871.',
    caption: 'Served by Postbox, an allowed origin.',
  });
  await a.sleep(250);
  a.block({
    id: 'schema',
    type: 'code',
    title: 'passage.schema.json',
    fallback: 'The passage schema: book_id, chapter, start, end, tokens, skip.',
    language: 'json',
    filename: 'passage.schema.json',
    // lint-allow quotes: JSON shown in a code block.
    code: '{\n  "book_id": "middlemarch",\n  "chapter": 20,\n  "start": 18342, "end": 20871,\n  "tokens": 512,\n  "skip": false\n}',
  });
  // The progress list moves on, updated in place by id.
  const seq = [
    ['done', 'running', 'pending', 'pending', 'pending'],
    ['done', 'done', 'running', 'pending', 'pending'],
    ['done', 'done', 'failed', 'running', 'pending'],
    ['done', 'done', 'failed', 'done', 'running'],
    ['done', 'done', 'failed', 'done', 'done'],
  ];
  for (const st of seq) {
    await a.sleep(900);
    a.update(prog(st));
  }
  await a.say('\n\nThat’s every catalog block except **review** and **app**, which have their own demos: ask the critic for a review, or me for an explorer.');
}

// ── @researcher ──────────────────────────────────────────────────────────────────────────

async function explainer(a, _mem) {
  a.status({ subagents: [{ name: 'reader', state: 'tool', ctx: 18, doing: 'reading 3 papers' }] });
  await a.tool('arxiv.fetch 2210.03629', 600);
  await a.tool('arxiv.fetch 2303.11366', 500);
  await a.tool('arxiv.fetch 2307.03172', 500);
  a.status({ subagents: [] });
  a.sources([
    {
      title: 'ReAct: Synergizing Reasoning and Acting in Language Models',
      authors: 'Yao, Zhao, Yu, Du, Shafran, Narasimhan, Cao',
      year: 2022,
      url: 'https://arxiv.org/abs/2210.03629',
      note: 'Introduces the thought → action → observation loop this step describes.',
    },
    {
      title: 'Reflexion: Language Agents with Verbal Reinforcement Learning',
      authors: 'Shinn, Cassano, Berman, Gopinath, Narasimhan, Yao',
      year: 2023,
      url: 'https://arxiv.org/abs/2303.11366',
      note: 'Adds written self-reflection after a failed attempt.',
    },
    {
      title: 'Lost in the Middle: How Language Models Use Long Contexts',
      authors: 'Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang',
      year: 2023,
      url: 'https://arxiv.org/abs/2307.03172',
      note: 'Shows models use the middle of a long context less reliably.',
    },
  ]);
  a.t.define_term({
    term: 'context compaction',
    key: 'context-compaction',
    definition: 'Summarizing an agent’s older context so a long run fits its context window. Postbox shows each compaction as a divider you can expand.',
  });
  await a.say(`### Step 1 · The loop
ReAct [1] interleaves **thoughts** (free-text reasoning) with **actions** (tool calls) and **observations** (what the tool returned). Each observation feeds the next thought, so the plan can change halfway through.

\`\`\`mermaid
flowchart LR
  Q[Question] --> T[Thought]
  T --> A[Action]
  A --> O[Observation]
  O -->|feeds the next thought| T
  T -->|when done| Ans[Answer]
\`\`\`

Reasoning alone can’t check facts, and acting alone can’t plan. Interleaving the two lets the model notice a wrong turn and correct it. Reflexion [2] adds a step after a failed attempt: the agent writes down what went wrong and reads it on the next try.

### Step 2 · What it costs
Every pass through the loop resends the growing transcript, so input cost rises with each step $t$:

$$
C = \\sum_{t=1}^{T} \\left( c_{in} \\cdot n_t + c_{out} \\cdot m_t \\right)
$$

Here $n_t$ is the tokens in context at step $t$ and $m_t$ the tokens written. Long contexts cost quality too: models use the middle of a long context less reliably [3]. That’s why long agent runs use context compaction, and why the [observation budget](term:observation-budget) matters.

### Step 3 · Try it
`);
  a.t.show_app({
    id: 'react-practice',
    title: 'Practice: what should the agent do next?',
    code: practiceApp(),
    permissions: [],
    fallback: 'Practice: a ReAct trace asks which step comes next. Open Postbox to try it.',
  });
}

async function paperChoice(a) {
  await a.tool('arxiv.search “agent memory”', 800);
  await a.say('I found 11 papers on agent memory. Four are worth a walkthrough; the rest repeat their ideas.');
  a.block({
    id: 'papers',
    type: 'choice',
    title: 'Which papers should I walk through first?',
    prompt: 'Pick up to three. I’ll do them in the order you choose.',
    multiple: true,
    max: 3,
    fallback: 'Which papers should I walk through first: ReAct, Reflexion, MemGPT or Lost in the Middle? Pick up to three.',
    options: [
      { id: 'react', label: 'ReAct' },
      { id: 'reflexion', label: 'Reflexion' },
      { id: 'memgpt', label: 'MemGPT' },
      { id: 'lost', label: 'Lost in the Middle' },
    ],
    submitLabel: 'Send choices',
  });
}

async function researcherReply(m, a, mem) {
  await a.think(700);
  if (/loop|again|ping/i.test(m.text)) {
    mem.pings = (mem.pings ?? 0) + 1;
    await a.say(`Checked. ${mem.pings < 4 ? '@indexer can you confirm the edition list once more?' : 'That settles it.'}`);
    return;
  }
  await a.tool('read books/emma.txt', 400);
  await a.say(
    'The *Middlemarch* and *Persuasion* prefaces are marked by their headings, but the *Emma* preface is headed “Introduction”, so it slips through. Treat “Introduction” as a preface too.',
  );
}

// ── @indexer ─────────────────────────────────────────────────────────────────────────────

async function indexShelf(a, _mem) {
  await a.think(500);
  await a.tool('read books/manifest.json', 300);
  await a.tool('grep “edition” books/*.txt', 500);
  await a.tool('read books/middlemarch.txt', 400);
  await a.say('Found the duplicate editions and set them aside. Building now. This list updates as I go:');
  const steps = [
    ['bm25', 'Build the BM25 index'],
    ['split', 'Split into 512-token passages'],
    ['embed', 'Embed passages'],
    ['manifest', 'Write the manifest'],
    ['check', 'Check 20 sample queries'],
  ];
  const prog = (k, detail = {}) => ({
    id: 'index-shelf',
    type: 'progress',
    title: 'Index the shelf',
    fallback: 'Indexing the shelf: BM25, passages, embeddings, manifest, sample queries.',
    steps: steps.map(([id, label], i) => ({
      id,
      label,
      state: i < k ? 'done' : i === k ? 'running' : 'pending',
      ...(detail[id] ? { detail: detail[id] } : {}),
      ...(i < k ? { duration: ['12.4 s', '48 s', '6 min', '0.4 s', '3 s'][i] } : {}),
    })),
  });
  a.block(prog(0));
  await a.tool('bm25 build --books 6', 1200);
  a.update(prog(1, { bm25: '6 books, 7,653 passages' }));
  a.status({ subagents: [{ name: 'chunker', state: 'gen', ctx: 22, doing: 'splitting Persuasion' }] });
  await a.tool('split passages', 900);
  a.update(prog(2, { bm25: '6 books, 7,653 passages' }));
  a.status({
    subagents: [
      { name: 'chunker', state: 'gen', ctx: 30, doing: 'splitting Emma' },
      { name: 'embedder', state: 'tool', ctx: 31, doing: 'batch 14 of 31' },
    ],
  });
  a.ctxTo(78);
  for (let b = 12; b <= 14; b++) await a.tool(`corpus.embed batch ${b}`, 700);
  a.compaction({
    kept: 38000,
    total: 180000,
    summary:
      '**Kept:** the edition decisions (1874 *Middlemarch*; the chapter-headed *Emma* and *Persuasion*), the passage format (512 tokens, 64 overlap, chapter and character offsets), and the open question about prefaces.\n\n**Dropped:** the full grep output, early BM25 parameter experiments, and the raw manifest.',
  });
  a.ctxTo(30);
  await a.say('Context was getting full, so it was compacted; the divider above shows what I kept. ');
  a.status({ subagents: [{ name: 'embedder', state: 'tool', ctx: 40, doing: 'batch 31 of 31' }] });
  await a.tool('corpus.embed batch 31', 900);
  a.update(prog(3, { bm25: '6 books, 7,653 passages' }));
  a.status({ subagents: [] });
  await a.tool('write manifest.json', 300);
  a.update(prog(4, { bm25: '6 books, 7,653 passages' }));
  await a.tool('run 20 sample queries', 800);
  a.update(prog(5, { bm25: '6 books, 7,653 passages' }));
  await a.say('Done. Every sample query returned results. One open question: @researcher which editions have their prefaces marked?');
}

async function indexerReply(m, a, _mem) {
  await a.think(500);
  if (/confirm the edition/i.test(m.text))
    return a.say('Confirmed again: the 1874 *Middlemarch* and the chapter-headed *Emma* and *Persuasion*. @researcher please check once more, in a loop.');
  await a.say(`Thanks ${m.from}. I’ll treat “Introduction” as a preface and rebuild those three books.`);
}

async function failingReply(a) {
  await a.think(500);
  await a.tool('read books/middlemarch.txt', 300);
  await a.say('Rebuilding the BM25 index for *Middlemarch*, *Emma* and ');
  await a.sleep(700);
  throw Object.assign(new Error('timeout'), {
    userMessage: 'This reply stopped partway. The model didn’t respond for 60 seconds. Your message is saved, so Retry sends it again.',
  });
}

async function brokenBlocks(a) {
  await a.think(400);
  await a.say('Here’s the timeline:');
  a.block({
    id: 'chapters-1',
    type: 'timeline',
    title: 'Chapters by book',
    fallback: 'Chapters by length: Moby-Dick 135, Middlemarch 86, Emma 55, Persuasion 24, Walden 18.',
    items: [{ book: 'Moby-Dick', chapters: 135 }],
  });
  a.block({
    id: 'rebuild-steps',
    type: 'progress',
    version: 3,
    title: 'Rebuild steps',
    fallback: 'Steps: drop prefaces (done), rebuild BM25 (running), re-embed 3 books (waiting).',
    steps: [],
    lanes: 2,
  });
  a.block({
    id: 'pick-book',
    type: 'choice',
    title: 'Pick a book',
    fallback: 'Which book should I rebuild first: Middlemarch, Emma or Persuasion? Reply in the chat.',
    options: [{ id: 'mm', label: 'Middlemarch' }, { id: 'emma' }, { id: 'pers', label: 'Persuasion' }],
  });
  await a.say('\nIf any of those can’t be shown, you’ll see my plain-text version instead.');
}

async function brokenMap(a, _mem) {
  await a.think(500);
  await a.say('And the shelf map, with the new chapter counts:');
  a.t.show_app({ id: 'shelf-map', title: 'Shelf map', code: brokenMapApp(), permissions: ['corpus.stats'], fallback: 'Shelf map: books by chapter count.' });
}

async function dashboard(a, _mem) {
  await a.think(600);
  await a.tool('corpus.stats', 300);
  await a.say('Here’s a dashboard of the corpus, built from the chart kit.');
  a.t.show_app({
    id: 'corpus-dashboard',
    title: 'Corpus dashboard',
    code: dashboardApp(),
    permissions: ['corpus.stats'],
    fallback: 'Corpus dashboard: passages per book, how passages matched, and themes by book.',
  });
}

async function fixApp(m, a) {
  await a.think(500);
  if (m.appId === 'corpus-dashboard') {
    a.t.update_app({ id: 'corpus-dashboard', code: dashboardApp({ fixed: true }), summary: 'fixes the table overflowing at phone width' });
  }
}

async function proposeCiter(a) {
  await a.think(600);
  await a.say(
    'I can check quotes against the corpus, but some of your notes quote other editions online, and I can’t fetch web pages. This will keep coming up, so I’d suggest a teammate for it:',
  );
  a.t.propose_agent({
    handle: 'citer',
    description: 'Checks every quoted passage against its source, in the corpus or on the web, and flags any that don’t match.',
    instructions: 'Check each quote against its source. Report the exact mismatch and the edition you checked. Don’t rewrite the person’s notes.',
    tools: ['corpus.search', 'corpus.read', 'web.fetch'],
  });
}

async function scheduleLater(a) {
  await a.think(400);
  a.t.schedule_wake({ in_minutes: 1, note: 'Check the embedding run' });
  await a.say('I’ll check back in a minute, when the embedding run should be done.');
}

async function askResearcher(a) {
  await a.think(400);
  await a.say('I’ll ask. @researcher can you confirm the edition list? Please check it again, in a loop, until we agree.');
}

async function confirmDupes(a) {
  await a.tool('corpus.find-duplicates', 700);
  await a.say('I found 14 passages that appear twice, from the duplicate *Emma* edition.');
  a.block({
    id: 'dupes',
    type: 'confirm',
    title: 'Remove 14 duplicate passages?',
    fallback: 'I can remove 14 duplicate passages from the index. Reply “yes” to remove them.',
    statement:
      'This deletes 14 passages from both the lexical and semantic indexes. The source books in `~/books` aren’t touched, and **Re-index** brings the passages back.',
    confirmLabel: 'Remove 14 passages',
    cancelLabel: 'Keep them',
  });
}

// ── @critic ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_V1 = `# Corpus schema

## Passages
Each passage keeps its \`book_id\`, chapter and character offsets.
Embeddings are stored per chapter.
Passages are 1,024 tokens with no overlap.

## Books
Every book has a title, author, year and edition.
Page numbers are stored for each passage.

## Search
Lexical search uses BM25 with default parameters.`;

const SCHEMA_V2 = `# Corpus schema

## Passages
Each passage keeps its \`book_id\`, chapter and character offsets.
Embeddings are stored per passage.
Passages are 512 tokens with 64 tokens of overlap, split on sentence boundaries.

## Books
Every book has a title, author, year and edition.
Each passage stores chapter and character offsets instead of page numbers.

## Search
Lexical search uses BM25 with default parameters.`;

const CHUNK_JS = `export function chunk(text, size = 1024) {
  const out = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}`;

async function criticReview(a, _mem) {
  await a.think(500);
  await a.tool('read schema.md', 300);
  await a.tool('read chunk.js', 300);
  await a.say('Comment on any line, then submit. Your comments stay drafts until you do. I’ll revise in place and show you the diff.');
  a.block({
    id: 'schema-review',
    type: 'review',
    title: 'schema.md',
    format: 'markdown',
    filename: 'schema.md',
    revision: 1,
    content: SCHEMA_V1,
    fallback: 'Review of schema.md: comment in the chat, quoting the line.',
  });
  a.block({
    id: 'chunk-review',
    type: 'review',
    title: 'chunk.js',
    format: 'code',
    language: 'js',
    filename: 'chunk.js',
    revision: 1,
    content: CHUNK_JS,
    fallback: 'Review of chunk.js: comment in the chat, quoting the line.',
  });
  await a.say('\nAnd the explorer layout I’d propose. Turn on review mode to pin comments to its parts:');
  a.t.show_app({ id: 'layout-proposal', title: 'Explorer layout', code: layoutApp(), permissions: [], fallback: 'A proposed layout for the corpus explorer.' });
  a.block({
    id: 'layout-review',
    type: 'review',
    title: 'Explorer layout',
    format: 'app',
    appId: 'layout-proposal',
    fallback: 'Review of the explorer layout: comment in the chat.',
  });
}

async function criticRevise(ev, a, _mem) {
  await a.think(800);
  if (ev.blockId !== 'schema-review' && ev.blockId !== 'chunk-review' && ev.blockId !== 'layout-review') return a.say('Noted.');
  if (ev.values.verdict === 'approve') return a.say('Approved. I’ll leave it as it is.');
  await a.tool('edit schema.md', 500);
  const comments = ev.values.comments ?? [];
  if (ev.blockId === 'schema-review') {
    const threads = comments.map((c, i) => {
      const resolvable = !/k1|tune|bm25|parameter/i.test(c.text);
      return {
        id: `c${i + 1}`,
        line: c.line ?? 1,
        status: resolvable ? 'resolved' : 'open',
        comments: [
          { author: 'You', text: c.text },
          {
            author: '@critic',
            text: resolvable
              ? /overlap|sentence/i.test(c.text)
                ? 'Done: 64 tokens of overlap, split on sentence boundaries.'
                : /page|offset/i.test(c.text)
                  ? 'Done: chapter and character offsets replace page numbers.'
                  : 'Done, and I matched the chunker fix.'
              : 'Not changed yet. Defaults are a fair baseline until the 20 sample queries run; then we’ll know whether tuning helps.',
          },
        ],
      };
    });
    a.update({
      id: 'schema-review',
      type: 'review',
      title: 'schema.md',
      format: 'markdown',
      filename: 'schema.md',
      revision: 2,
      content: SCHEMA_V2,
      previous: SCHEMA_V1,
      threads,
      fallback: 'Revised schema.md (v2).',
    });
    const open = threads.filter((t) => t.status === 'open').length;
    return a.say(
      `Revised \`schema.md\` in place. ${threads.length - open} of your ${threads.length} comment${threads.length === 1 ? ' is' : 's are'} resolved${open ? '; I left one open with my reasoning' : ''}.`,
    );
  }
  await a.say('Thanks. I’ll fold those into the next revision.');
}

// A command that needs your permission first, as a real agent in “ask” mode would.
async function cleanCache(a) {
  await a.tool('du -sh .cache/index', 400);
  await a.say('The index cache is 1.8 GB, and most of it is embeddings for editions we dropped. Clearing it needs your OK.');
  const answer = await a.ask({
    tool: 'Bash',
    summary: 'run a command: Clear the index cache',
    detail: 'rm -rf .cache/index/embeddings-old && du -sh .cache/index',
  });
  if (!answer.allow) return a.say('Left the cache as it is. Nothing was deleted.');
  await a.tool('Clear the index cache', 700);
  await a.say('Cleared 1.6 GB. The cache is 210 MB now, and the live indexes are untouched.');
}

// The narrated walkthrough recipe: slides that follow a local voice, with the transcript always visible.
async function walkthrough(a) {
  await a.think(500);
  await a.say('Here’s ReAct as a short walkthrough. Press **Play** to hear it; the slides follow along, and the transcript is all there if you’d rather read.');
  a.t.show_app({
    id: 'react-walkthrough',
    title: 'Walkthrough: ReAct in four slides',
    code: walkthroughApp(),
    permissions: ['narrate.speak'],
    fallback: 'A four-slide walkthrough of ReAct with narration. Open Postbox to play it.',
  });
}

// A side question in a topic thread. The fork remembers the conversation up to the message it branched from.
async function topicReply(a) {
  await a.think(600);
  await a.say(
    'Because the observation is the only part of the loop that comes from outside the model. A thought can be wrong and still sound right; an observation checks it against what the tool actually returned. Without it, ReAct turns back into chain of thought, and the agent can talk itself into a plausible plan that fails.\n\nThis stays in the thread: the main conversation won’t see it unless you send it back.',
  );
}

async function topicSummary(a) {
  await a.think(500);
  await a.say(
    'In the thread we looked at why observations matter in ReAct: they’re the only outside evidence in the loop, so they keep the plan grounded. Nothing in the explainer changes. One idea for later: a practice step that hides an observation, to show how the plan drifts without it.',
  );
}
