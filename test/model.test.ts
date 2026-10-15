import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseStartupArgs, startupOverrides } from '../src/cli.ts';
import { parseConfig, record } from '../src/config.ts';
import { Codex } from '../src/codex.ts';
import { Rpc } from '../src/rpc.ts';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const config = { teamId: 'T123', allowedUserIds: ['U123'], root: tmpdir(), channels: {} };

test('optional agent.model is validated without changing the default configuration', () => {
  assert.deepEqual(parseConfig(config).agent, { driver: 'codex', command: 'codex' });
  assert.equal(parseConfig({ ...config, agent: { model: ' custom-model ' } }).agent.model, 'custom-model');
  for (const model of ['', '  ', null, 123, [], {}]) {
    assert.throws(() => parseConfig({ ...config, agent: { model } }), /Invalid agent.model/);
  }
  assert.throws(() => parseConfig({ ...config, agent: { driver: 'claude', model: 'custom-model' } }), /requires the Codex driver/);
});

test('startup model flag supports both forms and overrides agent.model', () => {
  const agent = parseConfig({ ...config, agent: { model: 'configured-model' } }).agent;
  for (const args of [['--model', 'cli-model'], ['--model=cli-model']]) {
    assert.equal(startupOverrides(agent, parseStartupArgs(args)).model, 'cli-model');
  }
  assert.equal(startupOverrides(agent, parseStartupArgs([])).model, 'configured-model');
  assert.equal(startupOverrides(parseConfig(config).agent, parseStartupArgs([])).model, undefined);
  assert.throws(() => startupOverrides({ driver: 'claude', command: 'claude' }, { model: 'cli-model' }), /require the Codex driver/);
  for (const args of [['--model'], ['--model='], ['--model', '  '], ['--model', '--check']]) {
    assert.throws(() => parseStartupArgs(args));
  }
  assert.equal(parseStartupArgs(['--check', '--model=cli-model']).check, true);
  assert.equal(parseStartupArgs(['--discover']).discover, true);
  assert.equal(parseStartupArgs(['--setup']).setup, true);
});

test('reasoning effort validates config and overrides independently of the model', () => {
  const agent = parseConfig({ ...config, agent: { model: 'configured-model', modelReasoningEffort: ' medium ' } }).agent;
  assert.deepEqual(startupOverrides(agent, parseStartupArgs([])), { model: 'configured-model', modelReasoningEffort: 'medium' });
  for (const args of [['--model-reasoning-effort', 'high'], ['--model-reasoning-effort=high']]) {
    assert.deepEqual(startupOverrides(agent, parseStartupArgs(args)), { model: 'configured-model', modelReasoningEffort: 'high' });
  }
  assert.deepEqual(startupOverrides(agent, parseStartupArgs(['--model=cli-model'])), { model: 'cli-model', modelReasoningEffort: 'medium' });
  assert.deepEqual(startupOverrides(agent, parseStartupArgs(['--model=cli-model', '--model-reasoning-effort=high'])),
    { model: 'cli-model', modelReasoningEffort: 'high' });
  assert.throws(() => startupOverrides({ driver: 'claude', command: 'claude' }, { modelReasoningEffort: 'high' }), /require the Codex driver/);
  for (const args of [['--model-reasoning-effort'], ['--model-reasoning-effort='], ['--model-reasoning-effort', '  '], ['--model-reasoning-effort', '--check']]) {
    assert.throws(() => parseStartupArgs(args));
  }
  for (const modelReasoningEffort of ['', '  ', null, 123, [], {}]) {
    assert.throws(() => parseConfig({ ...config, agent: { modelReasoningEffort } }), /Invalid agent.modelReasoningEffort/);
  }
  assert.throws(() => parseConfig({ ...config, agent: { driver: 'claude', modelReasoningEffort: 'high' } }), /requires the Codex driver/);
});

for (const [model, effort] of [[undefined, undefined], ['custom-model', undefined], [undefined, 'high'], ['custom-model', 'high']]) {
  test(`Codex ${model ? 'overrides' : 'inherits'} model (effort: ${effort}) for new, resumed, and scheduled turns`, async t => {
    const rpc = new Rpc(process.execPath, [fake]);
    const codex = new Codex(rpc, undefined, { model, modelReasoningEffort: effort });
    t.after(() => codex.close());
    const checkModel = (params: unknown, turn = false) => {
      assert.equal(Object.hasOwn(record(params), 'model'), model !== undefined);
      assert.equal(record(params).model, model);
      if (turn) {
        assert.equal(Object.hasOwn(record(params), 'effort'), effort !== undefined);
        assert.equal(record(params).effort, effort);
      } else {
        assert.equal(Object.hasOwn(record(params), 'config'), effort !== undefined);
        assert.equal(record(record(params).config).model_reasoning_effort, effort);
      }
    };
    const read = async (thread: string) => record(record(await rpc.request('thread/read', { threadId: thread })).thread);
    const thread = await codex.create(tmpdir());
    checkModel((await read(thread)).startParams);
    await codex.input(thread, tmpdir(), 'first');
    checkModel(record(((await read(thread)).turns as unknown[]).at(-1)).startParams, true);
    assert.equal(rpc.recycle(), true);
    await codex.resume(thread, tmpdir());
    checkModel((await read(thread)).resumeParams);
    await codex.input(thread, tmpdir(), 'resumed');
    checkModel(record(((await read(thread)).turns as unknown[]).at(-1)).startParams, true);
    const scheduled = { unattended: true, sandbox: 'read-only' as const, approvalPolicy: 'never' as const };
    const scheduledThread = await codex.create(tmpdir(), scheduled);
    checkModel((await read(scheduledThread)).startParams);
    await codex.input(scheduledThread, tmpdir(), 'scheduled', [], scheduled);
    const params = record(record(((await read(scheduledThread)).turns as unknown[]).at(-1)).startParams);
    checkModel(params, true);
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(record(params.sandboxPolicy).type, 'readOnly');
    await codex.input(thread, tmpdir(), 'hold');
    await codex.input(thread, tmpdir(), 'steer');
    assert.equal(record(((await read(thread)).steerInput as unknown[])[0]).text, 'steer');
  });
}
