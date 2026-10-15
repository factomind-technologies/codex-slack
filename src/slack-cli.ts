import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { expandPath, record } from './config.ts';
import { controlRequest } from './control.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    file: { type: 'string' }, session: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [action, id] = positionals;
  if (values.help || !action) {
    console.log(`Usage: codex-slack-message <action> [id] [options]

context                          Current session's exact Slack channel and capabilities
post-message --file request.json  Send Markdown text to the bound channel or thread
upload-file --file request.json   Attach a Markdown report from configured upload roots
thread-replies [--file page.json] Read a page of replies; defaults to the bound thread
operation <id>                   Inspect a saved send/upload, including partial outcomes

post-message JSON: {"id":"summary-2026-10-14","destination":"channel","text":"..."}
upload-file JSON: {"id":"report-2026-10-14","destination":"channel","path":"/reports/day.md"}
Use destination "thread" for the session's original thread. No arbitrary channel IDs.
thread-replies JSON: {"root":"123.456","limit":15,"cursor":"..."}; use nextCursor
for another page. Permission errors are distinct from an empty messages array.
--file - reads JSON from stdin. Supply a stable unique id for each intended write.
Repeating an id with the same arguments returns its recorded result without sending
again. Inspect uncertain/partial results; never blindly retry with a new id.
--session defaults to CODEX_THREAD_ID. --state-dir defaults to CODEX_SLACK_STATE_DIR
or ~/.local/state/codex-slack. No Slack token or plugin is needed by this command.
Uploads require daemon config slackUploadRoots and the live files:write scope.
An operation is successful only when status is completed, with actual Slack IDs.`);
    return;
  }
  if (positionals.length > 2 || !['context', 'post-message', 'upload-file', 'thread-replies', 'operation'].includes(action)) throw new Error('Invalid arguments; use --help');
  if ((action === 'post-message' || action === 'upload-file') && !values.file) throw new Error('Write operations require --file JSON (or --file -)');
  const payload = values.file ? record(JSON.parse(readFileSync(values.file === '-' ? 0 : values.file, 'utf8'))) : {};
  const session = values.session ?? process.env.CODEX_THREAD_ID;
  if (!session) throw new Error('Supply --session or CODEX_THREAD_ID for a Slack-linked session');
  const stateDir = expandPath(values['state-dir'] ?? process.env.CODEX_SLACK_STATE_DIR ?? '~/.local/state/codex-slack');
  const result = await controlRequest(path.join(stateDir, 'control.sock'), {
    ...payload, ...(id ? { id } : {}), scope: 'slack', action, session,
  });
  console.log(JSON.stringify(result, null, 2));
  if (['failed', 'uncertain', 'running'].includes(String(record(result).status))) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Slack bridge command failed' }));
  process.exitCode = 1;
});
