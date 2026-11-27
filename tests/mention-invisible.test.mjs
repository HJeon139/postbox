// #1840: an invisible format character (Unicode Cf) between the @ and the handle, or inside it, still makes a mention.
// The case that prompted it: an agent's hand-off written as "@" + U+200C + handle looked like a mention in the room and
// woke no one. A name with no @, a quote and code still wake no one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMentions, unaddressed } from '../shared/text.mjs';

const h = ['agent-b', 'critic'];
// The characters #1840 names, and two other Cf ones: soft hyphen and a bidi mark.
const INVISIBLE = { ZWSP: '\u200B', ZWNJ: '\u200C', ZWJ: '\u200D', WJ: '\u2060', BOM: '\uFEFF', SHY: '\u00AD', LRM: '\u200E' };

test('#1840 an invisible character after the @ still mentions the handle', () => {
  for (const [name, c] of Object.entries(INVISIBLE)) assert.deepEqual(parseMentions(`please look, @${c}agent-b`, h), ['agent-b'], name);
});

test('#1840 an invisible character inside the handle still mentions it', () => {
  for (const [name, c] of Object.entries(INVISIBLE)) {
    assert.deepEqual(parseMentions(`@age${c}nt-b, over to you`, h), ['agent-b'], name);
    assert.deepEqual(parseMentions(`@${c}agent${c}-b${c} done`, h), ['agent-b'], name);
  }
});

test('#1840 the recorded case: an escalation with U+200C wakes its agent, and counts as addressed', () => {
  const said = 'Blocked on the gate. @\u200Ccritic, can you check the diff?';
  assert.deepEqual(parseMentions(said, h), ['critic']);
  assert.deepEqual(unaddressed('critic: @\u200Ccritic please', h), []);
});

test('#1840 still no mention: a name with no @, a quote, code, an email, or only invisible characters', () => {
  for (const c of Object.values(INVISIBLE)) {
    assert.deepEqual(parseMentions(`ask agent-b${c} about it`, h), []);
    assert.deepEqual(parseMentions(`> @${c}agent-b said so`, h), []);
    assert.deepEqual(parseMentions(`run \`@${c}agent-b\` there`, h), []);
    assert.deepEqual(parseMentions(`\`\`\`\n@${c}agent-b\n\`\`\``, h), []);
    assert.deepEqual(parseMentions(`mail x@${c}critic.com`, h), []);
    assert.deepEqual(parseMentions(`@${c}${c} alone`, h), []);
  }
});

test('#1840 an unknown handle with an invisible character stays unknown', () => {
  assert.deepEqual(parseMentions('@\u200Bnobody and @agent-\u200Dc', h), []);
});

test('#1840 a line copied from the conversation stays a copy when its mention carries an invisible character', () => {
  const asked = [];
  const isCopy = (id, said) => {
    asked.push(said);
    return id === 'it_big0137' && said.endsWith('built it');
  };
  // A copy names its agent without waking it; the copy check finds the line's mention the way parseMentions does.
  assert.deepEqual(parseMentions('it_big0137: @\u200Ccritic: built it', h, isCopy), []);
  assert.deepEqual(asked, ['@\u200Ccritic: built it']);
  // The same line with another id is the message's own, and wakes.
  assert.deepEqual(parseMentions('it_abcdefgh: @\u200Ccritic: built it', h, isCopy), ['critic']);
});
