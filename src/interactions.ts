import { randomUUID } from 'node:crypto';
import type { KnownBlock, View } from '@slack/types';
import { record } from './config.ts';
import type { Agent } from './agent.ts';
import type { ServerRequest } from './rpc.ts';
import type { Binding, Store } from './store.ts';
import { mcpFormContent, supportedMcpForm } from './mcp-elicitation.ts';

type Question = { id: string; question: string; options: { label: string; description?: string }[] };
type Pending = {
  request?: ServerRequest; asyncId?: string; binding: Binding; turnId?: string; kind: 'approval' | 'questions';
  choices?: Record<string, unknown>; questions?: Question[];
  mcpSchema?: Record<string, unknown>;
};

/** Button tokens reference live requests; neither decisions nor thread IDs come from Slack. */
export class Interactions {
  private pending = new Map<string, Pending>();
  private items = new Map<string, { thread: string; turn: string; item: Record<string, unknown> }>();
  constructor(private rpc: Agent, private store: Store,
    private reply?: (binding: Binding, text: string, user: string, id: string) => void) {}
  observe(thread: string, turn: string, item: Record<string, unknown>): void {
    if (item.type === 'fileChange' || item.type === 'commandExecution') this.items.set(`${thread}:${String(item.id)}`, { thread, turn, item });
  }
  clear(thread?: string, turnId?: string): void {
    for (const [token, pending] of this.pending) {
      if (!thread || (pending.binding.thread === thread && (!turnId || pending.turnId === turnId))) this.pending.delete(token);
    }
    for (const [key, entry] of this.items) {
      if (!thread || (entry.thread === thread && (!turnId || entry.turn === turnId))) this.items.delete(key);
    }
  }
  resolved(id: unknown, thread: unknown): void {
    for (const [token, pending] of this.pending) {
      if (pending.request?.id === id && pending.binding.thread === thread) this.pending.delete(token);
    }
  }
  receive(request: ServerRequest): void {
    const binding = this.store.byThread(String(request.params.threadId ?? ''));
    if (!binding) { this.rpc.reject(request.id, 'No Slack binding for this request'); return; }
    const token = randomUUID();
    const base = { request, binding, turnId: typeof request.params.turnId === 'string' ? request.params.turnId : undefined };
    if (request.method === 'item/tool/requestUserInput') {
      const raw = request.params.questions;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3 || raw.some(q => record(q).isSecret)) {
        this.unsupported(request, binding, 'This question cannot be represented in Slack (secret input or unsupported question count).'); return;
      }
      const questions: Question[] = raw.map(value => {
        const q = record(value);
        const options = Array.isArray(q.options) ? q.options.map(o => {
          const option = record(o);
          return { label: String(option.label ?? ''), ...(option.description ? { description: String(option.description) } : {}) };
        }) : [];
        return { id: String(q.id ?? ''), question: String(q.question ?? ''), options };
      });
      if (questions.some(q => !q.id || !q.question || this.questionText(q).length > 2800 || q.options.length > 99 || q.options.some(o => !o.label || o.label.length > 75))) {
        this.unsupported(request, binding, 'Question is too large for a Slack form.'); return;
      }
      this.pending.set(token, { ...base, kind: 'questions', questions });
      this.postQuestions(token, binding, questions);
      return;
    }
    let choices: Record<string, unknown>;
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const available = request.params.availableDecisions;
      choices = { accept: { decision: 'accept' }, decline: { decision: 'decline' }, cancel: { decision: 'cancel' } };
      if (Array.isArray(available)) choices = Object.fromEntries(Object.entries(choices).filter(([key]) => available.includes(key)));
    } else if (request.method === 'item/permissions/requestApproval') {
      const permissions = Object.fromEntries(Object.entries(record(request.params.permissions)).filter(([, value]) => value !== null));
      choices = { accept: { permissions, scope: 'turn' }, decline: { permissions: {}, scope: 'turn' } };
      if (!request.params.permissions) { this.unsupported(request, binding, 'Unknown permissions request shape.'); return; }
    } else if (request.method === 'mcpServer/elicitation/request') {
      const schema = record(request.params.requestedSchema);
      if (request.params.mode === 'url') {
        choices = { accept: { action: 'accept', content: null }, decline: { action: 'decline', content: null }, cancel: { action: 'cancel', content: null } };
      } else if (request.params.mode === 'form' && supportedMcpForm(schema)) {
        if (!Object.keys(record(schema.properties)).length) {
          choices = { accept: { action: 'accept', content: {} }, decline: { action: 'decline', content: null }, cancel: { action: 'cancel', content: null } };
        } else {
          const details = JSON.stringify(request.params, null, 2);
          if (details.length > 10000) { this.unsupported(request, binding, 'MCP form is too large for Slack; use a native client. No user denial was sent.'); return; }
          this.pending.set(token, { ...base, kind: 'questions', mcpSchema: schema,
            choices: { cancel: { action: 'cancel', content: null } },
            questions: [{ id: 'content', question: 'Enter the requested fields as a JSON object.', options: [] }] });
          this.store.enqueue(binding.key, { text: `${this.rpc.name} needs MCP form input.`, blocks: [
            ...Array.from({ length: Math.ceil(details.length / 2800) }, (_, i): KnownBlock => ({ type: 'section', text: { type: 'plain_text', text: details.slice(i * 2800, (i + 1) * 2800) } })),
            { type: 'actions', elements: [this.button('Answer', token, 'answer'), this.button('Cancel', token, 'cancel')] },
          ] });
          return;
        }
      } else {
        this.unsupported(request, binding, 'This MCP form requires a native client. No user denial was sent.'); return;
      }
    } else { this.unsupported(request, binding, `Unsupported interactive method: ${request.method}`); return; }

    const item = this.items.get(`${String(request.params.threadId)}:${String(request.params.itemId)}`)?.item;
    if (request.method === 'item/fileChange/requestApproval' && !item?.changes) {
      // The approval request itself contains no diff; its preceding item/started does.
      delete choices.accept;
    }
    const details = JSON.stringify({ ...request.params, ...(item ? { proposedAction: item } : {}) }, null, 2);
    if (details.length > 12_000 || !Object.keys(choices).length) {
      this.unsupported(request, binding, 'Approval details are too large or have unsupported decisions; no approval was granted.'); return;
    }
    this.pending.set(token, { ...base, kind: 'approval', choices });
    const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'plain_text', text: `${this.rpc.name} needs approval. Review the complete request below.` } }];
    for (let offset = 0; offset < details.length; offset += 2800) blocks.push({ type: 'section', text: { type: 'plain_text', text: details.slice(offset, offset + 2800) } });
    blocks.push({ type: 'actions', elements: Object.keys(choices).map(choice => this.button(choice === 'accept' ? 'Approve once' : choice === 'decline' ? 'Decline' : 'Cancel turn', token, choice)) });
    this.store.enqueue(binding.key, { text: `${this.rpc.name} needs approval.`, blocks });
  }
  receiveAsync(thread: string, item: Record<string, unknown>): boolean {
    if (!Array.isArray(item.questions) || !item.questions.length) return false;
    const binding = this.store.byThread(thread);
    if (!binding || !this.reply || typeof item.id !== 'string') return false;
    const questions = item.questions.map((value, i): Question => {
      const q = record(value);
      return { id: String(i), question: String(q.title ?? ''),
        options: Array.isArray(q.options) ? q.options.map(label => ({ label: String(label) })) : [] };
    });
    if (questions.length > 3 || questions.some(q => !q.question || this.questionText(q).length > 2800
      || q.options.length > 99 || q.options.some(o => !o.label || o.label.length > 75))) return false;
    const asyncId = thread + ':' + item.id;
    if ([...this.pending.values()].some(p => p.asyncId === asyncId)) return true;
    const token = randomUUID();
    this.pending.set(token, { binding, kind: 'questions', questions, asyncId });
    this.postQuestions(token, binding, questions, asyncId);
    return true;
  }
  private questionText(q: Question): string {
    return [q.question, ...q.options.map(o => o.label + (o.description ? ' — ' + o.description : ''))].join('\n');
  }
  private postQuestions(token: string, binding: Binding, questions: Question[], id?: string): void {
    const single = questions.length === 1 ? questions[0] : undefined;
    const choices = single && single.options.length <= 23
      ? single.options.map((o, i) => this.button(o.label, token, 'option:' + i)) : [];
    this.store.enqueue(binding.key, { text: this.rpc.name + ' has a question.', blocks: [
      ...questions.map((q): KnownBlock => ({ type: 'section', text: { type: 'plain_text', text: this.questionText(q) } })),
      { type: 'actions', elements: [...choices, this.button(choices.length ? 'Other…' : 'Answer', token, 'answer'), this.button('Cancel', token, 'cancel')] },
    ] }, id ? id + ':questions' : undefined);
  }
  private submit(pending: Pending, answers: Record<string, { answers: string[] }>, user?: string): void {
    if (pending.asyncId) {
      if (!user || !this.reply) throw new Error('An authorized user is required.');
      const text = Object.keys(answers).length
        ? pending.questions!.map(q => q.question + '\n' + answers[q.id]!.answers[0]).join('\n\n')
        : 'Cancel the pending question.';
      this.reply(pending.binding, text, user, pending.asyncId);
    } else {
      this.rpc.respond(pending.request!.id, pending.mcpSchema
        ? { action: 'accept', content: mcpFormContent(pending.mcpSchema, answers.content!.answers[0]!) }
        : { answers });
    }
  }
  private unsupported(request: ServerRequest, binding: Binding, reason: string): void {
    this.rpc.reject(request.id, reason);
    this.store.enqueue(binding.key, { text: reason });
  }
  private button(label: string, token: string, action: string) {
    return { type: 'button' as const, text: { type: 'plain_text' as const, text: label }, action_id: `cs:${action}`, value: token };
  }
  lookup(token: string): Pending | undefined { return this.pending.get(token); }
  choose(token: string, action: string, user?: string): void {
    const pending = this.pending.get(token);
    if (!pending) throw new Error('This request has expired or was already answered.');
    let result: unknown;
    if (pending.kind === 'questions' && action.startsWith('option:')) {
      const index = action.slice(7);
      const q = pending.questions?.length === 1 ? pending.questions[0] : undefined;
      const option = /^(0|[1-9][0-9]*)$/.test(index) ? q?.options[Number(index)] : undefined;
      if (!q || !option) throw new Error('Invalid response for this request.');
      this.submit(pending, { [q.id]: { answers: [option.label] } }, user);
      this.pending.delete(token);
      this.store.enqueue(pending.binding.key, { text: 'Your answer was sent to ' + this.rpc.name + ': ' + option.label + '.' });
      return;
    }
    if (pending.kind === 'questions' && action === 'cancel') result = pending.mcpSchema ? { action: 'cancel', content: null } : { answers: {} };
    else if (pending.choices && Object.hasOwn(pending.choices, action)) result = pending.choices[action];
    else throw new Error('Invalid response for this request.');
    if (pending.asyncId) this.submit(pending, {}, user);
    else this.rpc.respond(pending.request!.id, result);
    this.pending.delete(token);
    this.store.enqueue(pending.binding.key, { text: `Response sent to ${this.rpc.name}: ${action}.` });
  }
  modal(token: string): View {
    const pending = this.pending.get(token);
    if (!pending?.questions) throw new Error('This question has expired.');
    return {
      type: 'modal', callback_id: 'cs:answers', private_metadata: token,
      title: { type: 'plain_text', text: `Answer ${this.rpc.name}` },
      submit: { type: 'plain_text', text: 'Send' }, close: { type: 'plain_text', text: 'Close' },
      blocks: pending.questions.flatMap((q, i): KnownBlock[] => [
        { type: 'section', text: { type: 'plain_text', text: this.questionText(q) } },
        ...(q.options.length ? [{ type: 'input' as const, block_id: `q${i}`, optional: true,
          label: { type: 'plain_text' as const, text: 'Choose an option' },
          element: { type: 'static_select' as const, action_id: 'choice', options: q.options.map((o, index) => ({
            text: { type: 'plain_text' as const, text: o.label }, value: String(index),
          })) } }] : []),
        { type: 'input', block_id: `text${i}`, optional: q.options.length > 0, label: { type: 'plain_text', text: 'Your answer' },
          element: { type: 'plain_text_input', action_id: 'answer', multiline: true, max_length: 3000 } },
      ]),
    };
  }
  answer(token: string, values: unknown, user?: string): void {
    const pending = this.pending.get(token);
    if (!pending?.questions) throw new Error('This question has expired.');
    const answers: Record<string, { answers: string[] }> = {};
    pending.questions.forEach((q, i) => {
      const fields = record(values);
      const typed = record(record(fields[`text${i}`]).answer).value ?? record(record(fields[`q${i}`]).answer).value;
      const selected = record(record(record(fields[`q${i}`]).choice).selected_option).value;
      if (selected !== undefined && selected !== null && (typeof selected !== 'string' || !/^(0|[1-9][0-9]*)$/.test(selected) || !q.options[Number(selected)])) throw new Error('Invalid option.');
      const value = typeof typed === 'string' && typed.trim() ? typed : typeof selected === 'string' ? q.options[Number(selected)]?.label : undefined;
      if (typeof value !== 'string' || !value.trim() || value.length > 3000) throw new Error('Every question needs an answer.');
      answers[q.id] = { answers: [value] };
    });
    this.submit(pending, answers, user);
    this.pending.delete(token);
    this.store.enqueue(pending.binding.key, { text: `Your answers were sent to ${this.rpc.name}.` });
  }
}
