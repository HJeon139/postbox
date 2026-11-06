// The mock researcher’s ReAct explainer. Moved from server/adapters/mock.mjs, whose script calls explainer.

import { practiceApp } from '../mock/apps.mjs';

export async function explainer(a, _mem) {
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
