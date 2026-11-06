// The mock researcher’s ReAct explainer. Moved from server/adapters/mock.mjs, whose script calls explainer.
// By default it explains with one picture and one control that changes it; the practice app comes only when the
// person asks to try or practice, as the guide’s Explainer recipe says.

import { practiceApp } from '../mock/apps.mjs';

/** Whether the person asked for something to try, not only an explanation. */
export const asksToPractice = (text) => /\b(try|practice|quiz|exercise|test me)\b/i.test(text ?? '');

export async function explainer(a, text) {
  const practice = asksToPractice(text);
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

${practice ? '### Step 3 · Try it' : '### Step 3 · See it grow\nStep 1 reads about 290 tokens. Before you drag the slider: by step 8, how many tokens has the whole run read? Guess, then drag it to 8.'}
`);
  if (practice) return showPractice(a);
  a.t.show_app({
    id: 'react-context',
    title: 'How much the loop reads, step by step',
    code: contextApp(),
    permissions: [],
    fallback: 'A slider for the number of ReAct steps, with a bar for the tokens each step reads. Open Postbox to try it.',
  });
}

function showPractice(a) {
  a.t.show_app({
    id: 'react-practice',
    title: 'Practice: what should the agent do next?',
    code: practiceApp(),
    permissions: [],
    fallback: 'Practice: a ReAct trace asks which step comes next. Open Postbox to try it.',
  });
}

// One picture, one control: each step rereads the whole transcript, so the bars grow and their sum grows faster.
// Step 1 reads the question, a thought and an action (290 tokens); each later step adds an observation, a thought
// and an action (490).
const contextApp = () => `
<style>
  .ctx { display: flex; flex-direction: column; gap: 10px; padding: 14px; color: var(--text); }
  .ctx-bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .ctx-bars li { display: grid; grid-template-columns: 64px 1fr; gap: 8px; align-items: center; font-size: 13px; }
  .ctx-bar { height: 14px; border-radius: 3px; background: var(--accent); }
</style>
<div class="ctx">
  <label class="label" for="ctx-steps">Steps in the loop: <b id="ctx-n"></b></label>
  <input class="input" id="ctx-steps" type="range" min="1" max="8" step="1">
  <ol class="ctx-bars" id="ctx-bars" aria-label="Tokens each step reads"></ol>
  <p class="small" id="ctx-sum" role="status"></p>
</div>
<script>
  const reads = (t) => 290 + 490 * (t - 1);
  const $ = (id) => document.getElementById(id);
  function draw(n) {
    $('ctx-n').textContent = n;
    $('ctx-bars').innerHTML = Array.from({ length: n }, (_, i) =>
      '<li><span class="dim">Step ' + (i + 1) + '</span><span class="ctx-bar" style="width:' + (100 * reads(i + 1)) / reads(8) + '%" title="' + reads(i + 1) + ' tokens"></span></li>').join('');
    let total = 0;
    for (let t = 1; t <= n; t++) total += reads(t);
    $('ctx-sum').textContent = 'Step ' + n + ' reads ' + reads(n).toLocaleString('en-US') + ' tokens. The run has read ' + total.toLocaleString('en-US') + ' in all, ' + Math.round(total / reads(1)) + ' times step 1.';
  }
  $('ctx-steps').addEventListener('input', (e) => { draw(+e.target.value); postbox.saveState({ n: +e.target.value }); });
  postbox.ready.then(({ state }) => { const n = state?.n ?? 1; $('ctx-steps').value = n; draw(n); });
</script>`;
