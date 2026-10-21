import { execFileSync } from 'node:child_process';

/** Local deployment requires committed main, without remote access or publication. */
export function assertCommittedMain(cwd: string): void {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const remedy = 'Merge the intended work into main, run checks, and commit before restarting. No push is required.';
  if (git('branch', '--show-current') !== 'main') throw new Error(`Restart requires the main branch. ${remedy}`);
  if (git('status', '--porcelain')) throw new Error(`Restart requires a clean working tree. ${remedy}`);
  git('rev-parse', '--verify', 'HEAD');
}
