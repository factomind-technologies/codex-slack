import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenControl } from '../src/control.ts';
import { record } from '../src/config.ts';

const cli = fileURLToPath(new URL('../src/slack-cli.ts', import.meta.url));
function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', cli, ...args], { stdio: 'pipe' });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => { resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('Slack CLI carries multiline JSON over the private socket without shell interpolation', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slack-cli-'));
  const requests: Record<string, unknown>[] = [];
  const server = await listenControl(path.join(dir, 'control.sock'), async value => {
    requests.push(record(value));
    return { status: 'completed', channel: 'C123', ts: '1.2' };
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const payload = { id: 'summary', destination: 'channel', text: '# Summary\n\nLiteral `code` and $(not-a-shell-command)' };
  const result = await run(['post-message', '--session', 'exact-session', '--state-dir', dir, '--file', '-'], JSON.stringify(payload));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests, [{ ...payload, scope: 'slack', action: 'post-message', session: 'exact-session' }]);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'completed', channel: 'C123', ts: '1.2' });
  const missing = await run(['post-message', '--session', 'exact-session', '--state-dir', dir]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /require --file/);
});

test('Slack CLI exposes an uncertain operation as JSON with a failing exit code', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'slack-cli-'));
  const server = await listenControl(path.join(dir, 'control.sock'), async value => {
    assert.equal(record(value).id, 'partial');
    return { id: 'partial', status: 'uncertain', fileId: 'F123', uploaded: true, stage: 'completing-upload' };
  });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const result = await run(['operation', 'partial', '--session', 'exact-session', '--state-dir', dir]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).fileId, 'F123');
});
