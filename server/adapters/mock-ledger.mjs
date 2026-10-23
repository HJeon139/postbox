// The mock agents’ work ledger scene (#132). Moved from server/adapters/mock.mjs, whose script calls citationFix and
// fasterParser.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The work ledger’s scene (#132): real files in the demo’s research folder, and commands as Claude Code reports
// them. refs.bib stands for a file of the person’s that an agent changes; the notes go outside the project.
const CITE_V1 = `export function format(entry) {
  const [first, second] = entry.authors;
  return \`\${first.last} and \${second.last}, \${entry.title}\`;
}
`;
const CITE_V2 = `// Formats one bibliography entry as “Last and Last (year), Title”.
export function format(entry) {
  const names = entry.authors.map((a) => a.last);
  const who = names.length > 2 ? \`\${names[0]} et al.\` : names.join(' and ');
  return \`\${who} (\${entry.year ?? 'n.d.'}), \${entry.title}\`;
}
`;
const CITE_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from './cite.mjs';

test('two authors keep the year', () => {
  assert.equal(format({ authors: [{ last: 'Yao' }, { last: 'Zhao' }], year: 2023, title: 'ReAct' }), 'Yao and Zhao (2023), ReAct');
});
`;
const REFS = `@article{yao2023react,
  title = {ReAct: Synergizing Reasoning and Acting in Language Models},
  author = {Yao, Shunyu and Zhao, Jeffrey},
  year = {2023}
}
@article{shinn2023reflexion,
  title = {Reflexion},
  author = {Shinn, Noah and Cassano, Federico},
  yeer = {2023}
}
`;
export async function citationFix(a) {
  if (!a.folder) return a.say('This project has no folder, so there’s nothing for me to fix here.');
  const at = (p) => join(a.folder, p);
  const notes = join(a.folder, '..', 'workspaces', 'researcher', 'notes.md');
  // The person’s files as they were before this conversation, every time the demo plays.
  await writeFile(at('cite.mjs'), CITE_V1);
  await writeFile(at('refs.bib'), REFS);
  for (const p of [at('cite.test.mjs'), notes]) await rm(p, { force: true });
  await a.thinkAloud('The citation script drops the year, and one entry spells the field wrong. I’ll reproduce it, fix the formatter, then fix the entry.');
  await a.run('node cite.mjs refs.bib', {
    exit: 1,
    output: "TypeError: Cannot read properties of undefined (reading 'last')\n    at format (cite.mjs:3:44)",
    label: 'Ran the citation script',
  });
  await a.write(at('cite.mjs'), CITE_V2, { label: 'Edited cite.mjs' });
  await a.write(at('cite.test.mjs'), CITE_TEST, { label: 'Wrote cite.test.mjs' });
  await a.write(at('refs.bib'), REFS.replace('yeer', 'year'), { label: 'Edited refs.bib' });
  await a.run('node --test cite.test.mjs', { output: '✔ two authors keep the year (0.9ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0', label: 'Ran the tests' });
  await a.write(notes, '# Notes to self\n\n- refs.bib had a misspelled field (yeer); check the other bibliographies.\n', {
    label: 'Wrote notes.md',
  });
  await a.run('node serve-refs.mjs --port 4190', {
    background: true,
    label: 'Started the references server',
    output: 'Command running in background with ID: b1',
  });
  // lint-allow quotes: a shell command line, whose quotes are the shell’s.
  await a.run('gh issue create --title "Citations drop the year" --body "Fixed in cite.mjs; refs.bib had a typo."', {
    output: 'https://github.com/example/agent-research/issues/12',
    label: 'Filed an issue',
  });
  await a.say(
    'Fixed. `cite.mjs` now keeps the year and handles any number of authors, with a test for the two-author case, and `refs.bib` had `yeer` for `year` in one entry. I filed the issue, and left a note for myself about the other bibliographies. **Work** shows every file, with what it looked like before.',
  );
}
export async function fasterParser(a) {
  if (!a.folder) return a.say('This project has no folder, so there’s nothing to try here.');
  const path = join(a.folder, 'cite.mjs');
  const kept = await readFile(path, 'utf8').catch(() => CITE_V2);
  await a.thinkAloud('A regular expression might parse the bibliography faster than splitting fields. I’ll try it and measure.');
  await a.write(path, kept.replace("names.join(' and ')", "names.join(' & ')"), { label: 'Edited cite.mjs' });
  await a.run('node bench.mjs refs.bib', {
    exit: 1,
    output: 'bench: 412 ms per 1,000 entries (was 380 ms)\nslower than before',
    label: 'Benchmarked the parser',
  });
  await a.write(path, kept, { label: 'Put cite.mjs back' });
  await a.say('It was slower (412 ms against 380 ms per 1,000 entries), so I put `cite.mjs` back as it was. Nothing changed.');
}
