import type { KnownBlock } from '@slack/types';

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
  // Slack's native Markdown block accepts the standard Markdown produced by agents.
  // Keep the original text as the notification and accessibility fallback.
  return { text, blocks: [{ type: 'markdown', text }] };
}
