import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, textMessage } from '../src/messages.ts';

test('assistant replies use native Markdown with the original fallback text', () => {
  const text = [
    '# Status', '**Ready** and *readable* with ~~old text~~.',
    '- First item', '- [x] Complete', '> A quote',
    '[Documentation](https://example.com)',
    '```ts\nconst ready = true;\n```',
    '| Name | State |\n| --- | --- |\n| Bridge | Ready |',
  ].join('\n\n');
  assert.deepEqual(textMessage(text), { text, blocks: [{ type: 'markdown', text }] });
});

test('Markdown replies preserve explicit mentions, escaping, and code for Slack', () => {
  const text = '**Hi** <@U123><@W456> &lt;tag&gt; `a < b && b > c`';
  assert.deepEqual(textMessage(text), { text, blocks: [{ type: 'markdown', text }] });
});

test('chunk boundaries preserve user mentions and Unicode', () => {
  const mention = '<@U06HSGKT23A>';
  const prefix = '🦊'.repeat(2795);
  const text = prefix + mention + ' hello';
  const parts = chunks(text);
  assert.deepEqual(parts, [prefix, mention + ' hello']);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => Array.from(part).length <= 2800));
  assert.equal(textMessage(parts[1]!).blocks?.[0]?.type, 'markdown');
  assert.deepEqual(chunks(''), ['(No text returned.)']);
});
