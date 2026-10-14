import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Rpc } from '../src/rpc.ts';
import { Interactions } from '../src/interactions.ts';

class FakeRpc extends Rpc {
  responses: { id: string | number; result: unknown }[] = [];
  rejections: string[] = [];
  constructor() { super('unused'); }
  override respond(id: string | number, result: unknown) { this.responses.push({ id, result }); }
  override reject(_id: string | number, message: string) { this.rejections.push(message); }
}
function setup() {
  const store = new Store(':memory:'); const rpc = new FakeRpc();
  store.ingest({ id: '1', user: 'U123', key: 'T123:C123:1.1', channel: 'C123', root: '1.1', cwd: '/project', thread: null, text: '', unsupported: false });
  store.bind('T123:C123:1.1', 'thread-1');
  const ui = new Interactions(rpc, store);
  return { store, rpc, ui };
}
function token(store: Store): string {
  const payload = JSON.parse(store.deliveries().at(-1)!.payload);
  return payload.blocks.at(-1).elements[0].value;
}

test('approval uses native decisions and rejects replayed or invented actions', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'echo hello' } });
  const key = token(store);
  assert.throws(() => ui.choose(key, 'acceptForSession'), /Invalid/);
  ui.choose(key, 'accept');
  assert.deepEqual(rpc.responses, [{ id: 1, result: { decision: 'accept' } }]);
  assert.throws(() => ui.choose(key, 'accept'), /expired/);
});

test('restricted available decisions do not expose approval', t => {
  const { store, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', availableDecisions: ['decline', 'cancel'] } });
  assert.throws(() => ui.choose(token(store), 'accept'), /Invalid/);
});

test('file approvals include the proposed diff and cannot approve when the diff is missing', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-1' } });
  assert.throws(() => ui.choose(token(store), 'accept'), /Invalid/);
  ui.observe('thread-1', 'turn-1', { id: 'patch-2', type: 'fileChange', changes: [{ path: '/project/file', diff: '+fixed' }] });
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-2' } });
  assert.match(store.deliveries().at(-1)!.payload, /\+fixed/);
  ui.choose(token(store), 'accept');
  assert.deepEqual(rpc.responses[0]?.result, { decision: 'accept' });
});

test('permissions grant only requested fields for this turn and omit null fields', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', permissions: { network: { enabled: true }, fileSystem: null } } });
  ui.choose(token(store), 'accept');
  assert.deepEqual(rpc.responses[0]?.result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('question form maps answers to native question IDs', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 5, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'strategy', question: 'Which strategy?', options: [{ label: 'A', description: 'First option' }] }] } });
  const key = token(store);
  assert.equal(ui.modal(key).type, 'modal');
  ui.answer(key, { q0: { answer: { value: 'A, with adjustments' } } });
  assert.deepEqual(rpc.responses[0]?.result, { answers: { strategy: { answers: ['A, with adjustments'] } } });
});

test('requests expire when resolved, completed, or disconnected', t => {
  const { store, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  const first = token(store); ui.resolved(1, 'different-thread'); assert.ok(ui.lookup(first));
  ui.resolved(1, 'thread-1'); assert.equal(ui.lookup(first), undefined);
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-2' } });
  const second = token(store); ui.clear('thread-1', 'turn-1'); assert.ok(ui.lookup(second));
  ui.clear(); assert.equal(ui.lookup(second), undefined);
});

test('unsupported forms and oversized approvals never receive an automatic approval', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', mode: 'url' } });
  assert.equal(rpc.responses.length, 0);
  ui.choose(token(store), 'decline');
  assert.deepEqual(rpc.responses[0]?.result, { action: 'decline', content: null });
  ui.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', reason: 'a'.repeat(13000) } });
  assert.equal(rpc.rejections.length, 1);
  ui.receive({ id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'password', question: 'Secret?', isSecret: true }] } });
  assert.equal(rpc.rejections.length, 2);
});

test('MCP confirmations wait for an actual user decision instead of fabricating a decline', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 10, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', mode: 'form', message: 'Upload image?', requestedSchema: { type: 'object', properties: {} } } });
  assert.equal(rpc.responses.length, 0);
  assert.match(store.deliveries().at(-1)!.payload, /Upload image/);
  ui.choose(token(store), 'accept');
  assert.deepEqual(rpc.responses[0], { id: 10, result: { action: 'accept', content: {} } });
});

test('MCP form validates user input and cancellation uses the MCP protocol', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  const params = { threadId: 'thread-1', mode: 'form', requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] } };
  ui.receive({ id: 11, method: 'mcpServer/elicitation/request', params });
  const key = token(store);
  assert.throws(() => ui.answer(key, { q0: { answer: { value: '{"approved":"yes"}' } } }), /Invalid type/);
  assert.equal(rpc.responses.length, 0);
  ui.answer(key, { q0: { answer: { value: '{"approved":true}' } } });
  assert.deepEqual(rpc.responses[0]?.result, { action: 'accept', content: { approved: true } });
  ui.receive({ id: 12, method: 'mcpServer/elicitation/request', params });
  ui.choose(token(store), 'cancel');
  assert.deepEqual(rpc.responses[1]?.result, { action: 'cancel', content: null });
});

test('unsupported secret MCP forms report an unsupported request without inventing user denial', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 13, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', mode: 'form', requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } } });
  assert.equal(rpc.responses.length, 0);
  assert.match(rpc.rejections[0]!, /No user denial/);
});


test('single question choices are clickable and return labels without descriptions', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 20, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'drink', question: 'Which drink?', options: [{ label: 'Coffee', description: 'Hot' }, { label: 'Tea' }] }] } });
  const payload = JSON.parse(store.deliveries().at(-1)!.payload);
  const button = payload.blocks.find(block => block.type === 'actions').elements[0];
  assert.equal(button.text.text, 'Coffee');
  assert.throws(() => ui.choose(button.value, 'option:9'), /Invalid/);
  ui.choose(button.value, button.action_id.slice(3));
  assert.deepEqual(rpc.responses[0]?.result, { answers: { drink: { answers: ['Coffee'] } } });
  assert.throws(() => ui.choose(button.value, button.action_id.slice(3)), /expired/);
});

test('multiple questions have selectable options and optional custom text', t => {
  const { store, rpc, ui } = setup(); t.after(() => store.close());
  ui.receive({ id: 21, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [
    { id: 'drink', question: 'Drink?', options: [{ label: 'Coffee' }, { label: 'Tea' }] },
    { id: 'time', question: 'When?', options: [{ label: 'Now' }] },
  ] } });
  const key = token(store);
  assert.ok(ui.modal(key).blocks.some(block => block.type === 'input' && block.element.type === 'static_select'));
  assert.throws(() => ui.answer(key, { q0: { choice: { selected_option: { value: '99' } } } }), /Invalid|answer/);
  ui.answer(key, { q0: { choice: { selected_option: { value: '1' } } }, q1: { answer: { value: 'Tomorrow' } } });
  assert.deepEqual(rpc.responses[0]?.result, { answers: { drink: { answers: ['Tea'] }, time: { answers: ['Tomorrow'] } } });
});

test('async question buttons queue the actual user answer and survive turn completion', t => {
  const { store, rpc } = setup(); t.after(() => store.close());
  const replies = [];
  const ui = new Interactions(rpc, store, (binding, text, user, id) => replies.push({ binding, text, user, id }));
  const item = { id: 'async-1', text: '', questions: [{ title: 'Drink?', options: ['Coffee', 'Tea'] }] };
  assert.equal(ui.receiveAsync('thread-1', item), true);
  const payload = JSON.parse(store.deliveries().at(-1)!.payload);
  const button = payload.blocks.find(block => block.type === 'actions').elements[0];
  ui.clear('thread-1', 'turn-1');
  ui.choose(button.value, button.action_id.slice(3), 'U123');
  assert.equal(replies[0]?.user, 'U123');
  assert.match(replies[0]?.text, /Drink\?\nCoffee/);
  assert.equal(rpc.responses.length, 0);
  assert.throws(() => ui.choose(button.value, button.action_id.slice(3), 'U123'), /expired/);
});


test('async questions deduplicate, support custom text, cancel, and expire on disconnect', t => {
  const { store, rpc } = setup(); t.after(() => store.close());
  const replies = [];
  const ui = new Interactions(rpc, store, (_binding, text, user) => replies.push({ text, user }));
  const item = { id: 'async-custom', questions: [{ title: 'Drink?', options: ['Tea'] }] };
  ui.receiveAsync('thread-1', item);
  const key = token(store);
  const count = store.deliveries().length;
  ui.receiveAsync('thread-1', item);
  assert.equal(store.deliveries().length, count);
  ui.answer(key, { text0: { answer: { value: 'Water' } } }, 'U123');
  assert.deepEqual(replies[0], { text: 'Drink?\nWater', user: 'U123' });
  ui.receiveAsync('thread-1', { ...item, id: 'async-cancel' });
  ui.choose(token(store), 'cancel', 'U123');
  assert.match(replies[1].text, /Cancel/);
  ui.receiveAsync('thread-1', { ...item, id: 'async-expire' });
  const expired = token(store);
  ui.clear();
  assert.throws(() => ui.choose(expired, 'option:0', 'U123'), /expired/);
});
