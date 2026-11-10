// The customer judges the visual (#206, #333). A scenario with `- judge: visual` asks the tester, who plays the person,
// to judge the first visual that answers their question from its screenshot, as the person who asked, and record a
// structured verdict in that step’s answer. The bar is the maintainer’s, from their blind verdicts on 20 agent-made
// visuals on November 6, 2026 (agent-plugin/skills/visual-explainer/references/critique.md, “How far to trust it”): labeled
// boxes fail, a chart of one fixed answer isn’t a relationship, and unreadable text is a miss.

import { intentCell } from './intent-match.mjs';
import { cell } from './trigger-facts.mjs';

export const VERDICTS = ['landed', 'mostly', 'partly', 'missed'];

/** The tester’s optional `visual` answer, added to its step schema (tools/uat/tester.mjs). */
export const VISUAL_SCHEMA = {
  type: 'object',
  description: 'Only when the scenario asks you to judge visuals, and only the step a new visual first answers your question.',
  properties: {
    item: { type: 'string', description: 'The item label of the visual, such as I7.' },
    takeaway: { type: 'string', description: 'In one or two sentences, what the picture alone tells you.' },
    drawn: { type: 'boolean', description: 'Its parts are drawn as what they are, or as a chart whose marks carry the values, not boxes holding their names.' },
    relationship: { type: 'boolean', description: 'You can see how the things relate, and, where the idea is a dependence, what changes when one changes.' },
    one_idea: { type: 'boolean', description: 'One idea, without noise, on the first screen.' },
    readable: { type: 'boolean', description: 'All its text is readable: contrast, size, nothing overlapping or cut off, no raw TeX.' },
    verdict: { enum: VERDICTS },
  },
  required: ['item', 'takeaway', 'drawn', 'relationship', 'one_idea', 'readable', 'verdict'],
};

/** What the tester is told when the scenario asks it to judge. @param {{ judge?: string|null }} scenario */
export function judgePrompt(scenario) {
  if (scenario.judge !== 'visual') return '';
  return `

Judging the visual: this scenario asks you to. The first time an agent shows a visual that answers your question (an app, or a diagram in its reply), open its screenshot before you read the agent’s words, and fill visual in that step’s answer, once per new visual:
${JUDGING}`;
}

/** The judging instructions, shared by the tester’s prompt and the calibration against a person’s verdicts. */
export const JUDGING = `- takeaway: in one or two sentences, what the picture alone tells you. Not the reply’s words, and not a headline on the visual that states a conclusion: if the drawing doesn’t carry it, it doesn’t count.
- drawn: are its parts drawn as what they are or do (icons, small drawings, a cutaway, marks whose size or position carries the values)? A chart whose marks carry the values is yes: being a chart is never a fault. A diagram of labeled boxes and arrows is no, however tidy, a Mermaid flowchart included.
- relationship: can you see how the things it’s about relate? Where the idea is how one thing depends on another, can you also see what changes when one of them changes? A chart of one fixed answer, where you needed to see how the variables relate, is no. A tree, a map, a cycle or a cutaway with no variable to change is yes if its parts’ relations are clear.
- one_idea: does it show one idea, without marks that add nothing, on the first screen?
- readable: is all its text readable? Low contrast, text that overlaps or is cut off, tiny labels or raw TeX is no.
- verdict, as yourself, the person who asked: landed (what you needed to understand comes through from the picture), mostly (the core does; one part doesn’t), partly (the subject or some of the relations, not the idea), or missed (you’d only describe its parts). Text in boxes, a missing relationship and unreadable text each count heavily against it; unreadable text alone can make it a miss.`;

/** The report’s section listing each visual verdict, or nothing when there are none. @param {any[]} timeline */
export function visualSection(timeline) {
  const judged = timeline.filter((t) => t.visual);
  if (!judged.length) return [];
  const yes = (b) => (b ? 'yes' : 'no');
  return [
    '## Visual verdicts',
    '',
    'The customer’s judgment of each visual, from its screenshot (`- judge: visual`). Beside its takeaway, the agent’s intent for an app (#995), which the customer didn’t see, and whether the takeaway carries it.',
    '',
    '| Step | Item | Verdict | Drawn | Relationship | One idea | Readable | Takeaway | Intent | Match |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...judged.map(({ step, visual: v }) => {
      const takeaway = cell(String(v.takeaway));
      const cells = [
        step,
        v.item,
        v.verdict,
        yes(v.drawn),
        yes(v.relationship),
        yes(v.one_idea),
        yes(v.readable),
        takeaway,
        cell(intentCell(v)),
        v.match ?? '–',
      ];
      return `| ${cells.join(' | ')} |`;
    }),
    '',
  ];
}

/** `- judge: visual` turns the customer’s judging on; anything else is refused, not ignored. @param {string|undefined} spec */
export function judgeOf(spec) {
  if (spec === undefined) return null;
  if (String(spec).trim() === 'visual') return 'visual';
  throw new Error(`- judge takes “visual”, not “${String(spec).trim()}”.`);
}
