import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat as fileStat } from 'node:fs/promises';
import path from 'node:path';
import { allowedDirectory, authorized, record } from './config.ts';
import type { Bridge } from './bridge.ts';
import { textMessage, type Message } from './messages.ts';
import type { FilesCompleteUploadExternalArguments } from '@slack/web-api';

export type SlackContext = { team: string; channel: string; root: string | null; cwd: string; user: string; auditChannel?: string };
export type SlackClient = {
  postMessage(args: Message & { channel: string; thread_ts?: string; unfurl_links: false; unfurl_media: false; parse: 'none' }): Promise<{ channel?: string; ts?: string }>;
  getUploadURL(args: { filename: string; length: number }): Promise<{ file_id?: string; upload_url?: string }>;
  completeUpload(args: FilesCompleteUploadExternalArguments): Promise<{ files?: { id?: string }[] }>;
  replies(args: { channel: string; ts: string; limit: number; cursor?: string }): Promise<{ messages?: unknown[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>;
};
type Operation = {
  id: string; action: string; channel: string; threadTs?: string; status: 'running' | 'completed' | 'failed' | 'uncertain';
  stage: string; ts?: string; fileId?: string; uploaded?: boolean; shared?: boolean; sha256?: string; error?: string;
};
class InputError extends Error {}
function required(raw: Record<string, unknown>, name: string, limit = 200): string {
  const value = raw[name];
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new InputError(`Invalid ${name}`);
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+$/.test(value)) throw new InputError('Invalid thread timestamp');
  return value;
}
function slackError(error: unknown, upload = false): string {
  if (error instanceof InputError) return error.message;
  const code = record(record(error).data).error;
  if (typeof code === 'string' && ['missing_scope', 'not_authed', 'invalid_auth', 'token_revoked', 'not_in_channel', 'channel_not_found', 'thread_not_found', 'ratelimited', 'file_not_found', 'not_allowed_token_type', 'no_permission'].includes(code)) {
    return `Slack API: ${code}${code === 'missing_scope' ? upload
      ? ' (uploads require files:write; update the manifest and reauthorize the app)'
      : ' (check the installed app’s OAuth scopes)' : ''}`;
  }
  return 'Slack request failed; inspect operation status before any new send. No automatic retry was attempted.';
}
function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Uses only the daemon's Slack client. The agent receives no token or upload URL. */
export class SlackService {
  private active = new Set<string>();
  constructor(private bridge: Bridge, private client: SlackClient,
    private scheduledContext: (session: string) => SlackContext | undefined = () => undefined,
    private upload: (url: string, bytes: Uint8Array) => Promise<void> = async (url, bytes) => {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.slack.com')) throw new InputError('Invalid Slack upload URL');
      const response = await fetch(target, { method: 'POST', body: bytes as BodyInit,
        redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/octet-stream' } });
      if (!response.ok) throw new Error('Upload failed');
      await response.body?.cancel();
    }) {}

  context(session: string): SlackContext {
    const { store, config } = this.bridge;
    const binding = store.byThread(session);
    if (binding && binding.thread !== session) throw new InputError('Restricted automatic sessions cannot use the Slack publication interface');
    if (binding && !this.bridge.enabled(binding)) throw new InputError('Slack session binding is disabled');
    const user = binding && store.owner(binding.key);
    const scheduled = this.scheduledContext(session);
    const context = scheduled
      ? { ...scheduled, user: user ?? scheduled.user }
      : binding && user
        ? { team: binding.key.split(':')[0]!, channel: binding.channel, root: binding.root, cwd: binding.cwd, user }
        : undefined;
    if (!context || !authorized(config, context.team, context.user, context.channel)) throw new InputError('No authorized Slack binding for this session');
    if (context.auditChannel && !authorized(config, context.team, context.user, context.auditChannel)) throw new InputError('No authorized Slack audit binding for this session');
    try { allowedDirectory(config.root, context.cwd); }
    catch { throw new InputError('Slack session directory is unavailable or outside the configured root'); }
    return context;
  }
  private inspect(session: string, id: string): Operation {
    const row = this.bridge.store.slackOperation(session, id);
    if (!row) throw new InputError('Unknown Slack operation ID');
    const operation = JSON.parse(row.document) as Operation;
    if (operation.status === 'running' && !this.active.has(`${session}:${id}`)) operation.status = 'uncertain';
    return operation;
  }
  async command(value: unknown): Promise<unknown> {
    const raw = record(value);
    const session = required(raw, 'session');
    const context = this.context(session);
    if (raw.action === 'context') return { session, ...context,
      capabilities: ['post-message', 'upload-file', 'thread-replies', 'operation'],
      uploadRoots: this.bridge.config.slackUploadRoots ?? [], uploadTypes: ['.md'], maxUploadBytes: 25 * 1024 * 1024,
      note: 'Slack API scopes and token type may limit uploads or history; API errors are reported explicitly.' };
    const threadChannel = context.auditChannel ?? context.channel;
    const channel = raw.destination === 'thread' || raw.action === 'thread-replies' ? threadChannel : context.channel;
    if (raw.channel !== undefined && raw.channel !== channel) throw new InputError('Destination must be the session’s bound channel for this action');
    if (raw.action === 'operation') {
      const operation = this.inspect(session, required(raw, 'id'));
      if (operation.channel !== (operation.threadTs ? threadChannel : context.channel)) throw new InputError('Operation destination no longer matches this binding');
      return operation;
    }
    if (raw.action === 'thread-replies') {
      const ts = timestamp(raw.root ?? context.root);
      const limit = raw.limit ?? 15;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new InputError('limit must be 1–100');
      const cursor = raw.cursor === undefined ? undefined : required(raw, 'cursor', 2000);
      try {
        const result = await this.client.replies({ channel, ts, limit: Number(limit), ...(cursor ? { cursor } : {}) });
        return { channel, root: ts, messages: (result.messages ?? []).slice(0, Number(limit)).map(value => {
          const message = record(value);
          return { ts: message.ts, user: message.user, botId: message.bot_id,
            text: typeof message.text === 'string' ? message.text.slice(0, 12_000) : '', threadTs: message.thread_ts };
        }), hasMore: Boolean(result.has_more || result.response_metadata?.next_cursor), nextCursor: result.response_metadata?.next_cursor || null };
      } catch (error) { throw new InputError(slackError(error)); }
    }
    if (raw.action !== 'post-message' && raw.action !== 'upload-file') throw new InputError('Unknown Slack action');
    if (raw.destination !== 'channel' && raw.destination !== 'thread') throw new InputError('destination must be channel or thread');
    const threadTs = raw.destination === 'thread' ? timestamp(context.root) : undefined;
    const id = required(raw, 'id', 128);
    const text = raw.action === 'post-message' ? required(raw, 'text', 12_000) : undefined;
    const filename = raw.action === 'upload-file' ? required(raw, 'path', 4096) : undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify({ action: raw.action, channel, threadTs, text, filename })).digest('hex');
    const operation: Operation = { id, action: raw.action, channel, ...(threadTs ? { threadTs } : {}), status: 'running', stage: 'validating' };
    const { store } = this.bridge;
    if (!store.claimSlackOperation(session, id, fingerprint, JSON.stringify(operation))) {
      if (store.slackOperation(session, id)!.fingerprint !== fingerprint) throw new InputError('Operation ID already used with different arguments');
      return this.inspect(session, id);
    }
    const activeKey = `${session}:${id}`;
    this.active.add(activeKey);
    const save = (stage: string) => { operation.stage = stage; store.saveSlackOperation(session, id, JSON.stringify(operation)); };
    let attempted = false;
    try {
      if (text !== undefined) {
        save('posting'); attempted = true;
        const result = await this.client.postMessage({ ...textMessage(text), channel,
          ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false, parse: 'none' });
        if (!result.ts) throw new Error('Missing Slack timestamp');
        operation.ts = result.ts;
      } else {
        const report = await this.report(filename!);
        // File validation is async; recheck binding before publishing.
        this.context(session);
        operation.sha256 = createHash('sha256').update(report.bytes).digest('hex');
        save('requesting-upload'); attempted = true;
        const result = await this.client.getUploadURL({ filename: report.name, length: report.bytes.length });
        if (!result.file_id || !result.upload_url) throw new Error('Missing upload details');
        operation.fileId = result.file_id;
        save('uploading');
        await this.upload(result.upload_url, report.bytes);
        operation.uploaded = true;
        save('completing-upload');
        this.context(session);
        const complete = await this.client.completeUpload({ files: [{ id: result.file_id, title: report.name }], channel_id: channel,
          ...(threadTs ? { thread_ts: threadTs } : {}) });
        if (!complete.files?.some(file => file.id === result.file_id)) throw new Error('Upload completion not confirmed');
        operation.shared = true;
      }
      operation.status = 'completed'; save('completed');
    } catch (error) {
      // Only preflight failures are known to have no Slack side effect. All ambiguous
      // external writes stay inspectable, including partially uploaded file IDs.
      const rejected = typeof record(record(error).data).error === 'string';
      operation.status = attempted && !rejected && !(error instanceof InputError) ? 'uncertain' : 'failed';
      operation.error = slackError(error, operation.action === 'upload-file');
      save(operation.stage);
    } finally { this.active.delete(activeKey); }
    return operation;
  }
  private async report(filename: string): Promise<{ name: string; bytes: Buffer }> {
    if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.md') throw new InputError('Supply an absolute path to a Markdown (.md) report');
    let resolved: string;
    try { resolved = await realpath(filename); }
    catch { throw new InputError('Report file is unavailable'); }
    if (path.extname(resolved).toLowerCase() !== '.md') throw new InputError('Resolved report must be a Markdown (.md) file');
    const roots = this.bridge.config.slackUploadRoots ?? [];
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root)));
    if (!canonicalRoots.some(root => within(root, resolved))) throw new InputError('Report is outside configured slackUploadRoots');
    let file;
    try { file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new InputError('Report file cannot be opened'); }
    try {
      const stat = await file.stat();
      const verified = await realpath(resolved);
      const current = await fileStat(verified);
      if (!canonicalRoots.some(root => within(root, verified)) || current.dev !== stat.dev || current.ino !== stat.ino) throw new InputError('Report path changed while being opened');
      if (!stat.isFile() || stat.size === 0 || stat.size > 25 * 1024 * 1024) throw new InputError('Report must be a nonempty regular file up to 25 MiB');
      // Bounded read also covers a file growing after stat().
      const bytes = Buffer.alloc(Math.min(stat.size + 1, 25 * 1024 * 1024 + 1));
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== stat.size) throw new InputError('Report changed while being read; validate it again');
      return { name: path.basename(resolved), bytes: bytes.subarray(0, length) };
    } finally { await file.close(); }
  }
}
