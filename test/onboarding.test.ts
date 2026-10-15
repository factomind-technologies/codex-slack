import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Onboarding } from '../src/onboarding.ts';
import { Store } from '../src/store.ts';
import { allowedDirectory, authorized, parseConfig, type Config } from '../src/config.ts';
import { resolveSettings } from '../src/discovery.ts';

function fixture() {
  const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: tmpdir(), agent: { driver: 'codex', command: 'codex' }, scheduledBrowserUse: true };
  const store = new Store(':memory:');
  const posts: string[] = [];
  const onboarding = new Onboarding(config, store, async channel => { posts.push(channel); });
  return { config, store, posts, onboarding };
}

test('users-only configuration supports onboarding before any channel is bound', () => {
  const { config } = resolveSettings({ users: ['@erik'] }, {
    teamId: 'T123', teamName: 'Workspace', users: [{ id: 'U123', name: 'erik', label: 'Erik' }], channels: [],
  });
  assert.deepEqual(config.channels, {});
});

test('only bot invitations in this workspace prompt, once per unbound channel', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-legacy-'));
  const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: dir, agent: { driver: 'codex', command: 'unused' }, scheduledBrowserUse: true };
  const store = new Store(path.join(dir, 'bridge.sqlite'));
  const legacy = new DatabaseSync(path.join(dir, 'bridge.sqlite'));
  const posts: string[] = [];
  const onboarding = new Onboarding(config, store, async channel => { posts.push(channel); });
  try {
    config.channels.C999 = { cwd: tmpdir() };
    await onboarding.joined('T123', { user: 'U123', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T999', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C999' }, 'UBOT');
    assert.equal(posts.length, 0);
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    await onboarding.joined('T123', { user: 'UBOT', channel: 'C123' }, 'UBOT');
    assert.deepEqual(posts, ['C123']);
  } finally { store.close(); }
});

test('both controls enforce allowed users and workspace; paths and stale submissions are validated', async () => {
  const { config, store, onboarding } = fixture();
  try {
    await onboarding.ask('T123', 'C123');
    const token = store.channelSetups('T123')[0]!.token;
    assert.throws(() => onboarding.modal(token, 'T123', 'U999', 'C123'), /Only configured/);
    assert.throws(() => onboarding.modal(token, 'T123', 'U123', 'C999'), /no longer/);
    assert.throws(() => onboarding.bind(token, 'T999', 'U123', tmpdir()), /Only configured/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U999', tmpdir()), /Only configured/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', 'relative'), /absolute/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', '/nonexistent-codex-slack-test-folder'), /does not exist/);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', path.resolve('package.json')), /does not exist/);
    assert.equal(authorized(config, 'T123', 'U123', 'C123'), false);
    assert.equal(onboarding.modal(token, 'T123', 'U123', 'C123').type, 'modal');
    onboarding.bind(token, 'T123', 'U123', tmpdir());
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    assert.equal(authorized(config, 'T123', 'U123', 'C123'), true);
    assert.throws(() => onboarding.bind(token, 'T123', 'U123', tmpdir()), /already bound/);
  } finally { store.close(); }
});

test('unbound authorized messages are consumed, and !bind recovers a failed prompt', async () => {
  const { config, store, posts, onboarding } = fixture();
  try {
    assert.equal(await onboarding.message('T123', { user: 'U999', channel: 'C123', text: '!bind' }), false);
    assert.equal(posts.length, 0);
    const failed = new Onboarding(config, store, async () => { throw new Error('network'); });
    await assert.rejects(failed.ask('T123', 'C123'), /network/);
    await onboarding.ask('T123', 'C123');
    assert.equal(posts.length, 0);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: '!bind' }), true);
    assert.equal(posts.length, 1);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: 'do work' }), true);
    onboarding.bind(store.channelSetups('T123')[0]!.token, 'T123', 'U123', tmpdir());
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: '!bind' }), true);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: 'do work' }), false);
  } finally { store.close(); }
});

test('pending controls and directory bindings survive restart; saved decisions override manual config', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-onboarding-'));
  const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: dir, agent: { driver: 'codex', command: 'codex' }, scheduledBrowserUse: true };
  let store = new Store(path.join(dir, 'bridge.sqlite'));
  const posts: string[] = [];
  const post = async (channel: string) => { posts.push(channel); };
  try {
    await new Onboarding(config, store, post).ask('T123', 'C123');
    const token = store.channelSetups('T123')[0]!.token;
    store.close(); store = new Store(path.join(dir, 'bridge.sqlite'));
    const restored = new Onboarding(config, store, post);
    await restored.ask('T123', 'C123');
    assert.equal(posts.length, 1);
    restored.bind(token, 'T123', 'U123', tmpdir());
    store.close(); store = new Store(path.join(dir, 'bridge.sqlite'));
    config.channels = {};
    await new Onboarding(config, store, post).ask('T123', 'C123');
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    config.channels.C123 = { cwd: dir };
    await new Onboarding(config, store, post).ask('T123', 'C123');
    assert.equal(config.channels.C123.cwd, realpathSync(tmpdir()));
    assert.equal(posts.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('root allows itself and children, rejecting traversal, sibling prefixes and symlink escapes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-root-'));
  const root = path.join(dir, 'root');
  mkdirSync(root); mkdirSync(path.join(root, 'child')); mkdirSync(path.join(dir, 'root-other'));
  symlinkSync(dir, path.join(root, 'escape'));
  symlinkSync(path.join(root, 'child'), path.join(root, 'alias'));
  const { config, store, onboarding } = fixture();
  config.root = root;
  try {
    assert.equal(allowedDirectory(root, root), root);
    assert.equal(allowedDirectory(root, path.join(root, 'alias')), path.join(root, 'child'));
    for (const folder of [dir, path.join(root, '..'), path.join(dir, 'root-other'), path.join(root, 'escape')]) {
      assert.throws(() => allowedDirectory(root, folder), /configured root/);
      assert.throws(() => parseConfig({ ...config, channels: { C123: { cwd: folder } } }), /configured root/);
    }
    assert.deepEqual(parseConfig({ ...config, channels: { C123: { cwd: path.join(root, 'child') }, C999: { cwd: path.join(root, 'alias') } } }).channels, { C123: { cwd: path.join(root, 'child') }, C999: { cwd: path.join(root, 'child') } });
    const token = store.ensureChannelSetup('T123', 'C123').token;
    assert.throws(() => onboarding.preview(token, 'T123', 'U123', dir), /configured root/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('shared bindings preserve other channels, queued work, and sessions across restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-transfer-'));
  const child = path.join(dir, 'child'); mkdirSync(child);
  let store = new Store(path.join(dir, 'state.sqlite'));
  const config: Config = { root: dir, teamId: 'T123', allowedUserIds: ['U123'], channels: { COLD: { cwd: dir }, CCHILD: { cwd: child } }, stateDir: dir, agent: { driver: 'codex', command: 'unused' }, scheduledBrowserUse: true };
  try {
    const onboarding = new Onboarding(config, store, async () => {});
    const key = 'T123:COLD:1.1';
    store.ingest({ id: key, key, channel: 'COLD', root: '1.1', cwd: dir, thread: null, user: 'U123', text: 'pending', unsupported: false });
    store.enqueue(key, { text: 'pending reply' });
    await onboarding.ask('T123', 'CNEW');
    const token = store.channelSetups('T123').find(row => row.channel === 'CNEW')!.token;
    const view = onboarding.preview(token, 'T123', 'U123', dir);
    assert.ok(JSON.stringify(view).includes('Other channels can share this directory.'));
    assert.equal(config.channels.COLD?.cwd, dir); // Preview is read-only.
    assert.throws(() => onboarding.confirm(view.private_metadata!, 'T123', 'U999'), /expired/);
    onboarding.confirm(view.private_metadata!, 'T123', 'U123');
    assert.equal(config.channels.COLD?.cwd, dir);
    assert.equal(config.channels.CNEW?.cwd, dir);
    assert.equal(config.channels.CCHILD?.cwd, child);
    assert.equal(store.disabled(key), false);
    assert.equal(store.pending().length, 1);
    assert.equal(store.deliveries().length, 1);
    assert.throws(() => onboarding.confirm(view.private_metadata!, 'T123', 'U123'), /expired/);
    store.close(); store = new Store(path.join(dir, 'state.sqlite'));
    store.bindDirectory(store.ensureChannelSetup('T123', 'COLD').token, dir);
    config.channels = { CCHILD: { cwd: child } };
    const restored = new Onboarding(config, store, async () => {});
    await restored.ask('T123', 'COLD');
    await restored.ask('T123', 'CNEW');
    assert.equal(config.channels.COLD?.cwd, dir);
    assert.equal(config.channels.CNEW?.cwd, dir);
    assert.equal(store.disabled(key), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('another channel may bind the directory between preview and confirmation', async () => {
  const { config, store, onboarding } = fixture();
  try {
    await onboarding.ask('T123', 'C123');
    const token = store.channelSetups('T123')[0]!.token;
    const view = onboarding.preview(token, 'T123', 'U123', tmpdir());
    config.channels.C999 = { cwd: realpathSync(tmpdir()) };
    onboarding.confirm(view.private_metadata!, 'T123', 'U123');
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    assert.ok(config.channels.C999);
  } finally { store.close(); }
});

test('!bind as the first message prevents a second automatic welcome', async () => {
  const { store, posts, onboarding } = fixture();
  try {
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: ' !bind ' }), true);
    await onboarding.ask('T123', 'C123');
    assert.equal(posts.length, 1);
  } finally { store.close(); }
});

test('a mentioned !bind can recover a channel displaced by an older version', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-slack-legacy-'));
  const config: Config = { root: tmpdir(), teamId: 'T123', allowedUserIds: ['U123'], channels: {}, stateDir: dir, agent: { driver: 'codex', command: 'unused' }, scheduledBrowserUse: true };
  const store = new Store(path.join(dir, 'bridge.sqlite'));
  const legacy = new DatabaseSync(path.join(dir, 'bridge.sqlite'));
  const posts: string[] = [];
  const onboarding = new Onboarding(config, store, async channel => { posts.push(channel); });
  try {
    config.channels.C999 = { cwd: realpathSync(tmpdir()) };
    const setup = store.ensureChannelSetup('T123', 'C123');
    store.claimSetupPrompt(setup.token);
    // Legacy transfers left a null override and an already-claimed welcome prompt.
    legacy.prepare('INSERT INTO channel_overrides VALUES(?,?,NULL)').run('T123', 'C123');
    const key = 'T123:C123:1.1';
    legacy.prepare('INSERT INTO disabled_sessions VALUES(?)').run(key);
    assert.equal(await onboarding.message('T123', { user: 'U123', channel: 'C123', text: '<@UBOT> !bind' }), true);
    assert.deepEqual(posts, ['C123']);
    onboarding.bind(setup.token, 'T123', 'U123', tmpdir());
    assert.equal(config.channels.C123?.cwd, realpathSync(tmpdir()));
    assert.equal(config.channels.C999?.cwd, realpathSync(tmpdir()));
    assert.equal(store.disabled(key), true);
  } finally { legacy.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
