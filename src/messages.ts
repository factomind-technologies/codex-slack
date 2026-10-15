import type { KnownBlock, RichTextElement } from '@slack/types';

export type Message = { text: string; blocks?: KnownBlock[] };
export const escapeSlack = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function chunks(text: string, size = 2800): string[] {
  const result: string[] = [];
  let current = ''; let length = 0;
  // Keep explicit user mentions intact so chunk boundaries cannot turn them into literal text.
  for (const [token] of text.matchAll(/<@[UW][A-Z0-9]+>|./gsu)) {
    const count = Array.from(token).length;
    if (current && length + count > size) { result.push(current); current = ''; length = 0; }
    current += token; length += count;
  }
  if (current) result.push(current);
  return result.length ? result : ['(No text returned.)'];
}

export function textMessage(text: string): Message {
  const elements: RichTextElement[] = [];
  let offset = 0;
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (match.index > offset) elements.push({ type: 'text', text: text.slice(offset, match.index) });
    elements.push({ type: 'user', user_id: match[1]! });
    offset = match.index + match[0].length;
  }
  if (elements.length) {
    if (offset < text.length) elements.push({ type: 'text', text: text.slice(offset) });
    return { text, blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] }] };
  }
  return { text, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] };
}
