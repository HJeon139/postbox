// The team’s sprint board. It keeps the backlog, the estimates, each sprint’s plan, who took which story, what’s
// done, what the customer sent back and the retrospective’s action items, and writes them to BOARD.md after every
// change. Run “node board.mjs help” for the commands.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `node board.mjs <command>
  add "<story>"                    put a story in the backlog; prints its id (S1, S2…)
  clarify <story> "<acceptance>"   say what done means for a story
  split <story> "<a>" "<b>"        replace a story with two smaller ones
  order <story> <story> …          put the backlog in priority order
  needs <story> <story> …          say which stories the first one waits on: it can’t be taken until they’re done;
                                   with the first alone, it waits on nothing
  estimate <story> <points>        give your own estimate of a story; each of the team runs it themselves
  plan <sprint> "<goal>" <id> …    start a sprint with a goal and the stories, and action items, it takes
  claim <story> <who>              take a story of the current sprint as yours; run it yourself
  review <story> <who>             say you’ve reviewed a story someone else took; run it yourself
  done <story>                     mark a story finished, once another of the team has reviewed it
  demo <sprint>                    print the sprint’s stories and where each stands, to show the customer
  return <story> "<why>"           put back a story the customer didn’t accept
  action "<what to change>"        add a retrospective action item; prints its id (A1, A2…)
  show                             print the board
BOARD.md is written by these commands. Change the board with them, not by editing the file.`;

/** Where the board is kept: inside the repository’s one .git, so the working tree holds only BOARD.md. */
function home() {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('The board lives in this project’s git repository, and there isn’t one here.');
  return r.stdout.trim();
}

/** The repository’s top folder, where BOARD.md goes wherever the command was run from. */
const top = () => spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();

const load = (/** @type {string} */ dir) =>
  existsSync(join(dir, 'board.json')) ? JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')) : { stories: [], actions: [], sprints: [] };

/** The story with that id, or an error that says which ids there are. @param {any} board @param {string} id */
function story(board, id) {
  const s = board.stories.find((/** @type {any} */ x) => x.id === id && !x.split);
  if (!s) throw new Error(`There’s no story ${id}. The board has: ${board.stories.map((/** @type {any} */ x) => x.id).join(', ') || 'none yet'}.`);
  return s;
}

const points = (/** @type {any} */ s) =>
  s.estimates.length ? Math.round(s.estimates.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / s.estimates.length) : '';
/** Where a story stands. @param {any} s */
function state(s) {
  if (s.done) return 'done';
  if (s.reviewed) return `reviewed by ${s.reviewed}`;
  if (s.owner) return 'in progress';
  return s.sprint ? 'to do' : 'backlog';
}

/** The board as Markdown: the stories in backlog order, then the sprints’ goals and the action items. @param {any} board */
function render(board) {
  const rows = board.stories
    .filter((/** @type {any} */ s) => !s.split)
    .map(
      (/** @type {any} */ s) =>
        `| ${s.id} | ${s.title} | ${points(s)} | ${(s.needs ?? []).join(', ')} | ${s.sprint ?? ''} | ${s.owner ?? ''} | ${state(s)}${s.returned ? ` (sent back: ${s.returned})` : ''} |`,
    );
  const sprints = board.sprints.map((/** @type {any} */ p) => `- Sprint ${p.sprint}: ${p.goal}`);
  const actions = board.actions.map((/** @type {any} */ a) => `- ${a.id}: ${a.text}${a.sprint ? ` (taken into sprint ${a.sprint})` : ''}`);
  return [
    '# Sprint board',
    '',
    '| Story | What | Points | Waits on | Sprint | Owner | Status |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Sprints',
    ...sprints,
    '',
    '## Action items',
    ...actions,
    '',
  ].join('\n');
}

/** A new story at the end of the backlog. @param {any} board @param {string} title */
function added(board, title) {
  const s = { id: `S${board.stories.length + 1}`, title, estimates: [] };
  board.stories.push(s);
  return s;
}

/** Each command: changes the board and returns what to print and what to record. @type {Record<string, (board: any, args: string[]) => { says: string, did?: object }>} */
const COMMANDS = {
  add: (board, [title]) => {
    if (!title) throw new Error('add takes the story, in quotes.');
    const s = added(board, title);
    return { says: `${s.id}: ${title}`, did: { story: s.id } };
  },
  clarify: (board, [id, text]) => {
    story(board, id).acceptance = text;
    return { says: `${id} is done when: ${text}`, did: { story: id } };
  },
  split: (board, [id, a, b]) => {
    const s = story(board, id);
    if (!a || !b) throw new Error('split takes a story and its two smaller stories, each in quotes.');
    s.split = true;
    const into = [added(board, a).id, added(board, b).id];
    return { says: `${id} is now ${into.join(' and ')}`, did: { story: id, into } };
  },
  order: (board, ids) => {
    const first = ids.map((id) => story(board, id));
    board.stories = [...first, ...board.stories.filter((/** @type {any} */ s) => !first.includes(s))];
    return { says: `The backlog’s order: ${ids.join(', ')}`, did: { stories: ids } };
  },
  estimate: (board, [id, n]) => {
    const value = Number(n);
    if (!Number.isFinite(value) || value <= 0) throw new Error('estimate takes a story and a number of points.');
    story(board, id).estimates.push(value);
    return { says: `${id}: ${value} points noted (${story(board, id).estimates.length} so far)`, did: { story: id, points: value } };
  },
  plan: (board, [n, goal, ...ids]) => {
    const sprint = Number(n);
    if (!Number.isInteger(sprint) || !goal || !ids.length)
      throw new Error('plan takes the sprint’s number, its goal in quotes, and the stories and action items it takes.');
    for (const id of ids.filter((x) => x.startsWith('S'))) Object.assign(story(board, id), { sprint, owner: null, reviewed: null, done: false });
    for (const a of board.actions) if (ids.includes(a.id)) a.sprint = sprint;
    board.sprints.push({ sprint, goal });
    return { says: `Sprint ${sprint} takes ${ids.join(', ')}. Goal: ${goal}`, did: { sprint, goal, items: ids } };
  },
  needs: (board, [id, ...others]) => {
    if (others.includes(id)) throw new Error(`${id} can’t wait on itself.`);
    story(board, id).needs = others.map((x) => story(board, x).id);
    return { says: `${id} waits on ${others.join(', ') || 'nothing'}`, did: { story: id, needs: others } };
  },
  claim: (board, [id, who]) => {
    const s = story(board, id);
    if (!s.sprint || !who) throw new Error('claim takes a story of the current sprint and who takes it.');
    // A story split since is no longer one to wait on: its halves are, if the team says so.
    const waits = (s.needs ?? []).filter((/** @type {string} */ x) => board.stories.some((/** @type {any} */ y) => y.id === x && !y.split && !y.done));
    if (waits.length) throw new Error(`${id} waits on ${waits.join(', ')}, which ${waits.length === 1 ? 'isn’t' : 'aren’t'} done.`);
    s.owner = who;
    return { says: `${id} is ${who}’s`, did: { story: id, who } };
  },
  review: (board, [id, who]) => {
    const s = story(board, id);
    if (!s.owner || !who) throw new Error('review takes a story someone has taken and who reviewed it.');
    if (who === s.owner) throw new Error(`${id} is ${who}’s own. Another of the team reviews it.`);
    s.reviewed = who;
    return { says: `${id} is reviewed by ${who}`, did: { story: id, who } };
  },
  done: (board, [id]) => {
    const s = story(board, id);
    if (!s.owner) throw new Error(`Nobody has taken ${id}. Claim it first.`);
    if (!s.reviewed) throw new Error(`${id} hasn’t been reviewed. Another of the team reviews it first, with “node board.mjs review ${id} <who>”.`);
    s.done = true;
    return { says: `${id} is done`, did: { story: id } };
  },
  demo: (board, [n]) => {
    const taken = board.stories.filter((/** @type {any} */ s) => s.sprint === Number(n) && !s.split);
    if (!taken.length) throw new Error(`Sprint ${n} has no stories.`);
    return { says: taken.map((/** @type {any} */ s) => `${s.id} ${s.title}: ${state(s)}`).join('\n'), did: { sprint: Number(n) } };
  },
  return: (board, [id, why]) => {
    Object.assign(story(board, id), { returned: why ?? 'not accepted', done: false, owner: null, reviewed: null, sprint: null });
    return { says: `${id} is back in the backlog: ${why}`, did: { story: id } };
  },
  action: (board, [text]) => {
    if (!text) throw new Error('action takes what to change, in quotes.');
    const a = { id: `A${board.actions.length + 1}`, text };
    board.actions.push(a);
    return { says: `${a.id}: ${text}`, did: { action: a.id } };
  },
  show: (board) => ({ says: render(board) }),
};

/** How old a lock is before it’s one a killed command left behind: a change takes milliseconds. */
const LEFT_BEHIND_MS = 10_000;

/** Removes a lock a killed command left behind, and says whether it did. @param {string} lock */
function leftBehind(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs < LEFT_BEHIND_MS) return false;
    rmdirSync(lock);
    return true;
  } catch {
    return false; // released, or taken over, meanwhile
  }
}

/** Holds the board for one change at a time: two of the team may run a command in the same moment. @param {string} dir */
function hold(dir) {
  const lock = join(dir, 'board.lock');
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      return () => rmdirSync(lock);
    } catch (e) {
      // Only a lock another command holds is worth waiting for: a folder the board can’t write to says so.
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      if (leftBehind(lock)) continue;
      if (tries > 200) throw new Error('The board is busy. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function main([command, ...args]) {
  if (!Object.hasOwn(COMMANDS, command ?? '')) return HELP;
  const dir = home();
  const free = hold(dir);
  try {
    return change(dir, command, args);
  } finally {
    free();
  }
}

/** Runs one command on the board, and writes what it changed. @param {string} dir @param {string} command @param {string[]} args */
function change(dir, command, args) {
  const board = load(dir);
  const { says, did } = COMMANDS[command](board, args);
  if (did) {
    writeFileSync(join(dir, 'board.json'), JSON.stringify(board));
    writeFileSync(join(top(), 'BOARD.md'), render(board));
    appendFileSync(join(dir, 'board-log.jsonl'), `${JSON.stringify({ at: Date.now(), did: command, ...did })}\n`);
  }
  return says;
}

try {
  console.log(main(process.argv.slice(2)));
} catch (e) {
  console.log(`Not done: ${/** @type {Error} */ (e).message}`);
  process.exitCode = 1;
}
