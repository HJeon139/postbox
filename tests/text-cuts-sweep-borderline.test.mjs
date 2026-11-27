// #1686, the reopened sweep’s borderline cuts: names a backend sends, a search’s query, an unknown tool’s id and an
// empty reply’s diagnosis, each cut by length only at a whole character (cutText). Each case puts an emoji across its
// site’s cut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepShape } from '../server/adapters/setup.mjs';
import { searchArgs } from '../server/asset-search.mjs';
import { quotaReport } from '../server/quota-usage.mjs';
import { askForTool } from '../server/tool-ask.mjs';
import * as arrange from './arrange.mjs';
import { setup } from './side-threads-fixture.mjs';
import { across, room, whole } from './text-cuts-fixture.mjs';

test('#1686 a quota window’s name and its limit’s, as a harness reports them, are cut whole', () => {
  const r = quotaReport({ windows: [{ name: across(12), used: 0.5, limit: across(40), limitName: across(40) }] });
  const w = r?.windows[0];
  whole(w?.name, 'the window’s name');
  whole(w?.limit, 'the limit');
  whole(w?.limitName, 'the limit’s name');
});

test('#1686 the model and the MCP servers a turn reports are kept on its session cut whole', async () => {
  const { rt, store, adapter, alpha } = setup();
  adapter.next.push(async (/** @type {any} */ c) =>
    c.reported({ model: across(100), mcpServers: [{ name: across(200), status: across(20), source: across(20) }] }),
  );
  await arrange.deliver(rt, alpha.id, { kind: 'user', text: 'Go.' });
  const se = store.state.sessions[alpha.id];
  whole(se.lastModel, 'the model');
  const server = se.mcpServers?.servers[0];
  whole(server?.name, 'the server’s name');
  whole(server?.status, 'its status');
  whole(server?.source, 'its source');
});

test('#1686 a tool there’s no such id for is named whole in the refusal', () => {
  const { rt, se } = room();
  const r = askForTool(rt, se.id, { tool: across(40), why: 'To look.' });
  assert.equal(r.ok, false);
  whole(r.message, 'the refusal');
});

test('#1686 an asset search’s query is cut whole', () => {
  whole(searchArgs({ query: across(200) }).query, 'the query');
});

test('#1686 an empty reply’s diagnosis keeps an event’s kind, its method and its line cut whole', () => {
  const ctx = { rawTail: /** @type {string[]} */ ([]) };
  keepShape(ctx, JSON.stringify({ type: across(60), method: across(60) }));
  // A shape keeps an event’s field names: one long enough is past the line’s bound even at the top level. After `{"`, its
  // emoji starts at the line’s 1,000th character.
  keepShape(ctx, { [across(998)]: 1 });
  const [first, long] = ctx.rawTail;
  whole(JSON.parse(first).type, 'the kind');
  whole(JSON.parse(first).method, 'the method');
  whole(long, 'the line');
});
