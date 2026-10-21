import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertCommittedMain } from '../src/deployment.ts';

test('local restart requires committed clean main and never needs a published remote', t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'bridge-deployment-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  assert.throws(() => assertCommittedMain(cwd));
  git('commit', '--allow-empty', '-m', 'initial local commit');
  assert.doesNotThrow(() => assertCommittedMain(cwd));
  const filename = path.join(cwd, 'pending.txt');
  writeFileSync(filename, 'pending');
  assert.throws(() => assertCommittedMain(cwd), /clean working tree/);
  git('add', 'pending.txt');
  assert.throws(() => assertCommittedMain(cwd), /clean working tree/);
  git('commit', '-m', 'commit before restart');
  assert.doesNotThrow(() => assertCommittedMain(cwd));
  writeFileSync(filename, 'uncommitted edit');
  assert.throws(() => assertCommittedMain(cwd), /clean working tree/);
  git('restore', 'pending.txt');
  git('switch', '-c', 'feature');
  assert.throws(() => assertCommittedMain(cwd), /main branch/);
  git('switch', 'main');
  // An inaccessible origin must not block local deployment or cause network access.
  git('remote', 'add', 'origin', '/nonexistent/remote.git');
  git('commit', '--allow-empty', '-m', 'stable local revision');
  assert.doesNotThrow(() => assertCommittedMain(cwd));
});
