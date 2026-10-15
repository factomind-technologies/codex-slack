import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, textMessage } from '../src/messages.ts';

test('assistant replies render explicit Slack user mentions', () => {
  const text = 'Hi <@U06HSGKT23A>! Your apprentice reporting for duty :wave:';
  assert.deepEqual(textMessage(text), { text, blocks: [{ type: 'rich_text', elements: [{
    type: 'rich_text_section', elements: [
      { type: 'text', text: 'Hi ' },
      { type: 'user', user_id: 'U06HSGKT23A' },
      { type: 'text', text: '! Your apprentice reporting for duty :wave:' },
    ],
  }] }] });
});

test('multiple and adjacent user mentions render without parsing the surrounding text', () => {
  const text = '<@U123><@W456> & <tag> <!channel> @here *literal* <https://example.com|link>';
  assert.deepEqual(textMessage(text).blocks, [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [
    { type: 'user', user_id: 'U123' }, { type: 'user', user_id: 'W456' },
    { type: 'text', text: ' & <tag> <!channel> @here *literal* <https://example.com|link>' },
  ] }] }]);
});

test('replies without explicit user mentions keep their existing rendering', () => {
  const text = 'Hi @someone <!here> <@invalid> &lt;@U123&gt; **hello**';
  assert.deepEqual(textMessage(text), { text, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] });
});

test('chunk boundaries preserve user mentions and Unicode', () => {
  const mention = '<@U06HSGKT23A>';
  const prefix = '🦊'.repeat(2795);
  const text = prefix + mention + ' hello';
  const parts = chunks(text);
  assert.deepEqual(parts, [prefix, mention + ' hello']);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => Array.from(part).length <= 2800));
  assert.equal(textMessage(parts[1]!).blocks?.[0]?.type, 'rich_text');
  assert.deepEqual(chunks(''), ['(No text returned.)']);
});
