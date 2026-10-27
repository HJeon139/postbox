// Real tool replies expose app check evidence as text, including on a later read (#337).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

test('#337 MCP save receipts and later reads name the same version’s browser check', async () => {
  const { rt, adapter, t, alpha } = setup();
  let completed = false;
  adapter.next.push(async () => {
    const call = async (name, args) => {
      const reply = await handleMcp(
        rt,
        alpha.id,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        rt.turns.get(alpha.id).token,
      );
      assert.equal(reply.result.isError, false, JSON.stringify(reply));
      return reply.result.content[0].text;
    };
    const saved = await call('show_app', { id: 'lab', title: 'Lab', code: '<p>First</p>' });
    assert.match(saved, /lab[\s\S]*v1[\s\S]*pending/);
    assert.doesNotMatch(saved, /browser check: passed/);
    rt.appCheck('lab', { version: 1, problems: [] });
    assert.match(await call('read_message', { id: 'lab' }), /v1[\s\S]*passed/);
    const updated = await call('update_app', { id: 'lab', code: '<p>Second</p>' });
    assert.match(updated, /v2[\s\S]*pending/);
    rt.appCheck('lab', { version: 1, problems: [] });
    assert.match(await call('read_message', { id: 'lab' }), /v2[\s\S]*pending/);
    completed = true;
  });
  rt.sendMessage(t.id, { text: '@alpha build a lab' });
  await settle(rt);
  assert.equal(completed, true, 'the active turn exercised every tool reply assertion');
  assert.equal(adapter.calls.length, 1);
  assert.equal(rt.s.apps.lab.current, 2);
});
