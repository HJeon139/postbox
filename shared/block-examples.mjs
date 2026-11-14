// One small, valid block of each type (#1319), which a refusal shows, so an agent whose block was refused sees the
// shape it missed rather than guessing again. tests/block-json-schema.test.mjs checks each passes the catalog.

/** @type {Record<string, Record<string, any>>} */
export const BLOCK_EXAMPLES = {
  choice: {
    id: 'pick-db',
    type: 'choice',
    version: 1,
    fallback: 'Which database: Postgres or SQLite?',
    prompt: 'Which database?',
    options: [
      { id: 'postgres', label: 'Postgres' },
      { id: 'sqlite', label: 'SQLite', description: 'One file, no server.' },
    ],
  },
  form: {
    id: 'deploy-settings',
    type: 'form',
    version: 1,
    fallback: 'Which region, and how many replicas?',
    fields: [
      {
        id: 'region',
        label: 'Region',
        kind: 'select',
        options: [
          { id: 'us-east', label: 'US East' },
          { id: 'eu-west', label: 'EU West' },
        ],
      },
      { id: 'replicas', label: 'Replicas', kind: 'number', min: 1, max: 9, default: 2 },
    ],
  },
  table: {
    id: 'scores',
    type: 'table',
    version: 1,
    fallback: 'Scores: alpha 3, beta 5.',
    columns: [
      { id: 'name', label: 'Name' },
      { id: 'score', label: 'Score', kind: 'number' },
    ],
    rows: [{ id: 'alpha', cells: { name: 'alpha', score: 3 } }],
  },
  progress: {
    id: 'build',
    type: 'progress',
    version: 1,
    fallback: 'Building: compiled, tests running.',
    steps: [
      { id: 'compile', label: 'Compile', state: 'done' },
      { id: 'test', label: 'Run the tests', state: 'running', progress: { done: 2, total: 4, unit: 'suites' } },
    ],
  },
  card: {
    id: 'summary',
    type: 'card',
    version: 1,
    fallback: 'Release 2.0 is ready.',
    body: 'Release 2.0 is ready.',
    facts: [{ label: 'Tests', value: 'all pass' }],
  },
  confirm: { id: 'push', type: 'confirm', version: 1, fallback: 'Push main to origin?', statement: 'Run `git push origin main`?', confirmLabel: 'Push' },
  image: { id: 'cover', type: 'image', version: 1, fallback: 'The book’s cover.', src: 'https://example.com/cover.png', alt: 'The book’s cover' },
  code: { id: 'fix', type: 'code', version: 1, fallback: 'The fix: x = 1.', code: 'x = 1', language: 'python' },
  review: { id: 'draft', type: 'review', version: 1, fallback: 'The draft issue.', format: 'markdown', content: '# Draft' },
  app: { id: 'chart', type: 'app', version: 1, fallback: 'A chart of the scores.', code: '<p>Scores</p>' },
};

/**
 * The problems a refusal names, and the shape of the type the agent meant, when the catalog has it.
 * @param {string[]} errors  validateBlock’s @param {unknown} raw  the block as the agent sent it
 */
export function withShape(errors, raw) {
  const type = /** @type {any} */ (raw)?.type;
  const example = typeof type === 'string' && Object.hasOwn(BLOCK_EXAMPLES, type) ? BLOCK_EXAMPLES[type] : null;
  if (!example) return errors.join(' ');
  return `${errors.join(' ')} ${/^[aeiou]/.test(type) ? 'An' : 'A'} ${type} block looks like this: ${JSON.stringify(example)}.`;
}

/**
 * show_block’s refusal of an invalid block, on the laptop (server/block-show.mjs) and on a host (block-updates.mjs’s
 * hostShowRefusal), in the same words. @param {string[]} errors @param {unknown} raw
 */
export const notShown = (errors, raw) =>
  `The block wasn’t shown: ${withShape(errors, raw)} Fix it and send it again with the same id: nothing was shown under it.`;
