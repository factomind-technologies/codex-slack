import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Bridge } from '../src/bridge.ts';
import { Codex } from '../src/codex.ts';
import { Rpc } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { parseConfig, record, type Config } from '../src/config.ts';
import { SlackService, type SlackClient } from '../src/slack-service.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slack-service-'));
  const cwd = path.join(dir, 'project'); mkdirSync(cwd);
  const reports = path.join(dir, 'reports'); mkdirSync(reports);
  const report = path.join(reports, 'day.md'); writeFileSync(report, '# Validated report\n');
  const config: Config = { root: dir, teamId: 'T123', allowedUserIds: ['U123'], channels: { C123: { cwd }, C999: { cwd } },
    stateDir: dir, agent: { driver: 'codex', command: 'unused' }, scheduledBrowserUse: true, slackUploadRoots: [reports] };
  const filename = path.join(dir, 'bridge.sqlite');
  const store = new Store(filename);
  const bridge = new Bridge(config, store, new Codex(new Rpc('unused')), async () => {});
  for (const [channel, session] of [['C123', 'session-one'], ['C999', 'session-two']]) {
    const key = `T123:${channel}:1.1`;
    store.ingest({ key, id: key, channel: channel!, root: '1.1', cwd, thread: null, user: 'U123', text: 'hello', unsupported: false });
    store.bind(key, session!);
  }
  const calls: { method: string; args: unknown }[] = [];
  const client: SlackClient = {
    postMessage: async args => { calls.push({ method: 'post', args }); return { ts: '2.2', channel: args.channel }; },
    getUploadURL: async args => { calls.push({ method: 'url', args }); return { file_id: 'F123', upload_url: 'https://files.slack.com/private-upload' }; },
    completeUpload: async args => { calls.push({ method: 'complete', args }); return { files: [{ id: 'F123' }] }; },
    replies: async args => { calls.push({ method: 'replies', args }); return { messages: [] }; },
  };
  const upload = async (_url: string, bytes: Uint8Array) => { calls.push({ method: 'bytes', args: Buffer.from(bytes).toString('utf8') }); };
  const service = new SlackService(bridge, client, undefined, upload);
  const command = (args: object) => service.command({ session: 'session-two', ...args });
  t.after(async () => { await bridge.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, cwd, reports, report, config, filename, store, bridge, calls, client, upload, service, command };
}

test('context resolves the exact session among shared directories and rejects unknown or unauthorized sessions', async t => {
  const f = fixture(t);
  const context = record(await f.command({ action: 'context' }));
  assert.equal(context.channel, 'C999'); assert.equal(context.root, '1.1');
  assert.deepEqual(context.uploadRoots, [f.reports]);
  await assert.rejects(f.command({ action: 'context', session: 'unknown' }), /No authorized Slack binding/);
  f.config.allowedUserIds = [];
  await assert.rejects(f.command({ action: 'context' }), /No authorized Slack binding/);
  assert.equal(f.calls.length, 0);
});

test('disabled bindings and restricted triage sessions cannot publish', async t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.filename);
  db.prepare('INSERT INTO disabled_sessions VALUES(?)').run('T123:C999:1.1'); db.close();
  await assert.rejects(f.command({ action: 'context' }), /disabled/);
  f.store.bindTransient('T123:C123:1.1', 'restricted');
  await assert.rejects(f.command({ session: 'restricted', action: 'context' }), /Restricted automatic/);
});

test('channel posts omit thread_ts while thread posts retain the root; replays never resend', async t => {
  const f = fixture(t);
  const request = { action: 'post-message', id: 'summary', destination: 'channel', text: '**Validated**\n\nSummary' };
  const result = await f.command(request);
  assert.deepEqual(result, { id: 'summary', action: 'post-message', channel: 'C999', status: 'completed', stage: 'completed', ts: '2.2' });
  const args = record(f.calls[0]?.args);
  assert.equal(Object.hasOwn(args, 'thread_ts'), false);
  assert.deepEqual(args.blocks, [{ type: 'markdown', text: request.text }]);
  assert.deepEqual(await f.command(request), result);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.command({ ...request, text: 'changed' }), /different arguments/);
  await f.command({ ...request, id: 'thread-summary', destination: 'thread' });
  assert.equal(record(f.calls[1]?.args).thread_ts, '1.1');
  await assert.rejects(f.command({ ...request, id: 'other-channel', channel: 'C123' }), /bound channel/);
  assert.equal(f.calls.length, 2);
});

test('timeouts and crash recovery remain inspectable and do not duplicate writes', async t => {
  const f = fixture(t);
  f.client.postMessage = async () => { f.calls.push({ method: 'post', args: null }); throw new Error('secret token and request body'); };
  const request = { action: 'post-message', id: 'timeout', destination: 'channel', text: 'hello' };
  const result = record(await f.command(request));
  assert.equal(result.status, 'uncertain'); assert.equal(result.stage, 'posting');
  assert.ok(!JSON.stringify(result).includes('secret token'));
  const recoveredStore = new Store(f.filename);
  const recoveredBridge = new Bridge(f.config, recoveredStore, new Codex(new Rpc('unused')), async () => {});
  const recovered = new SlackService(recoveredBridge, f.client);
  assert.deepEqual(await recovered.command({ ...request, session: 'session-two' }), result);
  assert.equal(f.calls.length, 1);
  f.store.claimSlackOperation('session-two', 'crash', 'hash', JSON.stringify({ id: 'crash', channel: 'C999', status: 'running', stage: 'posting' }));
  assert.equal(record(await recovered.command({ action: 'operation', session: 'session-two', id: 'crash' })).status, 'uncertain');
  await recoveredBridge.stop(); recoveredStore.close();
});

test('concurrent identical requests claim only one Slack write', async t => {
  const f = fixture(t);
  let finish!: (value: { ts: string }) => void;
  f.client.postMessage = async () => { f.calls.push({ method: 'post', args: null }); return new Promise(resolve => { finish = resolve; }); };
  const request = { action: 'post-message', id: 'once', destination: 'channel', text: 'hello' };
  const first = f.command(request);
  assert.equal(record(await f.command(request)).status, 'running');
  finish({ ts: '3.3' });
  assert.equal(record(await first).status, 'completed'); assert.equal(f.calls.length, 1);
});

test('Markdown outside cwd can be attached from an explicit root without pasting report contents', async t => {
  const f = fixture(t);
  const request = { action: 'upload-file', id: 'report', destination: 'channel', path: f.report };
  const result = record(await f.command(request));
  assert.equal(result.status, 'completed'); assert.equal(result.fileId, 'F123');
  assert.equal(result.uploaded, true); assert.equal(result.shared, true); assert.equal(String(result.sha256).length, 64);
  assert.deepEqual(f.calls.map(call => call.method), ['url', 'bytes', 'complete']);
  assert.deepEqual(f.calls[2]?.args, { files: [{ id: 'F123', title: 'day.md' }], channel_id: 'C999' });
  assert.ok(!JSON.stringify(result).includes('private-upload'));
  assert.deepEqual(await f.command(request), result); assert.equal(f.calls.length, 3);
  await f.command({ ...request, id: 'thread-report', destination: 'thread' });
  assert.equal(record(f.calls[5]?.args).thread_ts, '1.1');
});

test('uploads reject unapproved roots, symlink escapes, missing or large files, and non-Markdown input before Slack calls', async t => {
  const f = fixture(t);
  const outside = path.join(f.cwd, 'outside.md'); writeFileSync(outside, 'private');
  symlinkSync(outside, path.join(f.reports, 'escape.md'));
  const big = path.join(f.reports, 'big.md'); writeFileSync(big, ''); truncateSync(big, 25 * 1024 * 1024 + 1);
  const folder = path.join(f.reports, 'folder.md'); mkdirSync(folder);
  for (const filename of [outside, path.join(f.reports, 'escape.md'), big, folder, path.join(f.reports, 'missing.md'), '/tmp/report.txt']) {
    const result = record(await f.command({ action: 'upload-file', id: filename, destination: 'channel', path: filename }));
    assert.equal(result.status, 'failed');
  }
  assert.equal(f.calls.length, 0);
  f.config.slackUploadRoots = [];
  assert.equal(record(await f.command({ action: 'upload-file', id: 'no-roots', destination: 'channel', path: f.report })).status, 'failed');
});

test('missing scope and uncertain upload completion expose sanitized partial outcomes', async t => {
  const f = fixture(t);
  const request = { action: 'upload-file', id: 'scope', destination: 'channel', path: f.report };
  const getURL = f.client.getUploadURL;
  f.client.getUploadURL = async () => { throw { data: { error: 'missing_scope', token: 'secret' } }; };
  const missing = record(await f.command(request));
  assert.match(String(missing.error), /files:write/); assert.ok(!JSON.stringify(missing).includes('secret'));
  f.client.getUploadURL = getURL;
  f.client.completeUpload = async () => { throw new Error('timeout including private upload URL'); };
  const partial = record(await f.command({ ...request, id: 'partial' }));
  assert.equal(partial.status, 'uncertain'); assert.equal(partial.stage, 'completing-upload');
  assert.equal(partial.fileId, 'F123'); assert.equal(partial.uploaded, true); assert.notEqual(partial.shared, true);
  assert.deepEqual(await f.command({ action: 'operation', id: 'partial' }), partial);
  assert.ok(!JSON.stringify(partial).includes('private upload URL'));
});

test('thread retrieval returns bounded pages, cursors, empty results, and actual API limitations', async t => {
  const f = fixture(t);
  f.client.replies = async args => {
    f.calls.push({ method: 'replies', args });
    return { messages: [{ ts: '1.2', text: 'reply', files: [{ url_private: 'secret' }] }], response_metadata: { next_cursor: 'page2' } };
  };
  const page = record(await f.command({ action: 'thread-replies', limit: 1 }));
  assert.equal(page.nextCursor, 'page2'); assert.equal(page.hasMore, true);
  assert.ok(!JSON.stringify(page).includes('secret'));
  assert.deepEqual(f.calls[0]?.args, { channel: 'C999', ts: '1.1', limit: 1 });
  f.client.replies = async args => { assert.equal(args.cursor, 'page2'); return { messages: [] }; };
  assert.deepEqual(record(await f.command({ action: 'thread-replies', cursor: 'page2' })).messages, []);
  f.client.replies = async () => { throw { data: { error: 'not_allowed_token_type' } }; };
  await assert.rejects(f.command({ action: 'thread-replies' }), /not_allowed_token_type/);
  await assert.rejects(f.command({ action: 'thread-replies', limit: 101 }), /1–100/);
});

test('configured upload roots validate directories without restricting reports to session cwd', t => {
  const f = fixture(t);
  assert.deepEqual(parseConfig({ ...f.config, slackUploadRoots: [f.reports] }).slackUploadRoots, [f.reports]);
  assert.throws(() => parseConfig({ ...f.config, slackUploadRoots: f.reports }), /array/);
  assert.throws(() => parseConfig({ ...f.config, slackUploadRoots: [f.report] }), /directories/);
});
