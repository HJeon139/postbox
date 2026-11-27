// #1686, the reopened sweep: an app’s retirement, and names and text the person typed or reads, cut by length only at
// a whole character (cutText), never between the two halves of a surrogate pair. Each case puts an emoji across its
// site’s cut. The converted sites with no case here are listed under “Not done” in the pull request that added them
// (#1686).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { runAgentCommand } from '../server/agent-commands.mjs';
import { storedFolder } from '../server/folder-path.mjs';
import { recordJob } from '../server/job-records.mjs';
import { liveFields, liveSession } from '../server/live-buffer.mjs';
import { ModelLists } from '../server/model-lists.mjs';
import { readHookFile } from '../server/permission-hooks.mjs';
import { createProject } from '../server/projects.mjs';
import { otherAuthor } from '../server/review-authors.mjs';
import { transientRetry } from '../server/turn-transient.mjs';
import { resolveViewAsk } from '../server/view-app/consent.mjs';
import { attachViewApp } from '../server/view-app/view-of.mjs';
import { validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { LIVE_CAPS } from '../shared/limits.mjs';
import { aboutThePerson, profileOf } from '../shared/profile.mjs';
import { anchorOf } from '../shared/review-comments.mjs';
import { tempDir } from './temp-dirs.mjs';
import { across, EMOJI, room, whole } from './text-cuts-fixture.mjs';

test('#1686 a retired app’s reason, and the title of the block that replaced it, are cut whole', () => {
  const r = room();
  r.tools.show_app({ id: 'old', title: 'Old', code: '<p>1</p>' });
  // A choice with no title is named by its prompt, which may run to 2,000 characters.
  const shown = r.tools.show_block({
    block: { id: 'pick', type: 'choice', version: 1, fallback: 'f', prompt: across(200), options: [{ id: 'a', label: 'A' }] },
  });
  assert.equal(shown.ok, true, shown.message);
  const res = r.tools.retire_app({ id: 'old', reason: across(300), replacedBy: 'pick' });
  assert.equal(res.ok, true, res.message);
  const retired = r.store.state.apps.old.retired;
  whole(retired.reason, 'the reason');
  whole(retired.replacedBy?.title, 'the replacing block’s title');
});

test('#1686 a conversation’s name and a project’s name are cut whole', async () => {
  const r = room();
  r.rt.threads.rename(r.t.id, across(120));
  whole(r.store.state.threads[r.t.id].title, 'the conversation’s name');
  const p = await createProject(r.store, { name: across(80), folder: tempDir('pb-cuts-project-') });
  whole(p.name, 'the project’s name');
});

test('#1686 why an agent asks for a tool, and an agent command the person runs, are kept whole', () => {
  const r = room();
  const asked = r.tools.ask_for_tool({ tool: 'shell', why: across(600) });
  assert.equal(asked.ok, true, asked.message);
  whole(r.items('toolask')[0]?.why, 'why');
  const { item } = runAgentCommand(r.rt, r.t.id, { sessionId: r.se.id, text: `/go ${across(50000 - 4)}` });
  whole(item.text, 'the command');
});

test('#1686 why the browser download failed is kept whole on view_app’s card', async () => {
  const r = room();
  attachViewApp(r.rt, /** @type {any} */ ({ dir: tempDir('pb-cuts-view-'), browser: { install: async () => ({ ok: false, message: across(400) }) } }));
  const card = r.rt.threads.addItem(r.t.id, { kind: 'viewask', sessionId: r.se.id, handle: 'alpha', turnId: null, status: 'open' });
  resolveViewAsk(r.rt, r.t.id, card.id, 'download');
  for (let i = 0; i < 50 && r.store.item(r.t.id, card.id)?.status === 'downloading'; i++) await new Promise((ok) => setImmediate(ok));
  whole(r.store.item(r.t.id, card.id)?.reason, 'the reason');
});

test('#1686 a hook’s command in the permissions panel, and a refused folder in its message, are cut whole', async () => {
  const file = join(tempDir('pb-cuts-hooks-'), 'settings.json');
  const hook = { type: across(20 - 1), command: across(200 - 1) };
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: across(100 - 1), hooks: [hook] }] } }));
  const read = await readHookFile(file);
  for (const k of ['type', 'text', 'matcher']) whole(read.hooks[0]?.[k], `the hook’s ${k}`);
  // A token the panel redacts shrinks the text it scanned: the scan’s own cut, at 2,000, is what then shows.
  const scanned = join(tempDir('pb-cuts-scan-'), 'settings.json');
  const token = `echo glpat-${'a'.repeat(2000 - 1 - 'echo glpat-'.length)}${EMOJI}tail`;
  writeFileSync(scanned, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: token }] }] } }));
  whole((await readHookFile(scanned)).hooks[0]?.text, 'the redacted command');
  // The folder is quoted as JSON, so its emoji is one later than in the folder.
  const refused = (() => {
    try {
      storedFolder({ handle: 'alpha', folder: `rel/${across(200 - 5)}` });
    } catch (e) {
      return /** @type {Error} */ (e).message;
    }
  })();
  whole(refused, 'the refusal');
});

test('#1686 a backend Postbox doesn’t run is named whole in the refusal', async () => {
  const lists = new ModelLists(new AdapterRegistry(), { file: join(tempDir('pb-cuts-models-'), 'models.json') });
  await assert.rejects(lists.list(across(40)), (/** @type {Error} */ e) => {
    whole(e.message, 'the refusal');
    return /isn’t one Postbox runs/.test(e.message);
  });
});

test('#1686 a failed turn’s retry names the steps it started whole', () => {
  const rt = { store: { pending: { session: () => null } }, config: {} };
  const turn = { steps: [{ id: 's1', kind: 'tool', label: across(80) }] };
  const retry = transientRetry(rt, { id: 'se1' }, turn, { kind: 'transient', status: 529 });
  whole(retry?.started[0], 'the started step');
});

test('#1686 another author quoted in a review, and a selection’s quote past its bound, are cut whole', () => {
  const author = otherAuthor({ threads: [{ comments: [{ author: across(60 - 1), text: 'x' }] }] }, 'alpha');
  whole(author, 'the other author');
  const line = across(2000);
  const a = anchorOf([line], { n: 1, c: 0 }, { n: 1, c: line.length });
  whole(a?.quote, 'the quote');
  assert.equal(a?.endCol, a?.quote.length, 'the anchor ends where the quote does');
});

test('#1686 the person’s profile, as a turn carries it, is cut whole', () => {
  const p = profileOf({ name: across(80), preferences: across(2000) });
  whole(p.name, 'the name');
  whole(p.preferences, 'the preferences');
  // Past the 1,500 characters a turn carries, the line is cut there: its emoji starts at character 1,500.
  const lines = aboutThePerson({ preferences: across(1500 - '- Preferences: '.length) });
  assert.match(lines.at(-1) ?? '', /Cut to/);
  for (const l of lines) whole(l, 'a line of the profile');
});

test('#1686 what the person typed in “other”, and an app’s summary, are quoted whole in the voice line', () => {
  const choice = { id: 'c', type: 'choice', options: [{ id: 'a', label: 'A' }], other: { label: 'Other' } };
  const chose = buildEvent(choice, 'choose', { selected: [], other: across(60 - 1) });
  assert.equal(chose.ok, true);
  whole(chose.ok && chose.voice, 'the voice line');
  const sent = buildEvent({ id: 'app', type: 'app', title: 'A' }, 'go', { summary: across(159) });
  assert.equal(sent.ok, true);
  whole(sent.ok && sent.quote, 'the app’s summary');
});

test('#1686 the example a choice’s string options are told to be like shows its label whole', () => {
  const r = validateBlock({ id: 'c', type: 'choice', version: 1, fallback: 'f', options: [across(40), 'Two'] });
  const said = JSON.stringify(r);
  assert.match(said, /must be objects like/);
  // JSON.stringify writes a lone half as its escape.
  assert.doesNotMatch(said, /\\\\ud[89ab]/i, 'the example’s label ends inside a character');
  assert.ok(said.includes('x'.repeat(39)), 'the label is there');
});

test('#1686 a running turn’s live text past its cap is cut whole', () => {
  const r = room();
  const turn = { id: 'tu1', sessionId: r.se.id, threadId: r.t.id, first: null };
  liveSession(r.rt, turn, { glimpse: across(LIVE_CAPS.string) });
  whole(liveFields(r.rt, turn).glimpse, 'the glimpse');
});

test('#1686 where a background job’s output is, as the agent is told it, is cut whole', () => {
  const r = room();
  const turn = { id: 'tu_job', sessionId: r.se.id, threadId: r.t.id, keepJobs: new Set(), stopReason: null };
  recordJob(r.rt, turn, { id: 'job1', state: 'running', command: 'sleep 1', label: 'Sleep', outputFile: across(1000) });
  whole(r.store.state.sessions[r.se.id].jobs?.[0]?.outputFile, 'the output file');
});
