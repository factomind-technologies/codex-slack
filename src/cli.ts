import { parseArgs } from 'node:util';
import type { AgentConfig, ModelOverrides } from './config.ts';

export function parseStartupArgs(args: string[]) {
  const { values } = parseArgs({ args, options: {
    discover: { type: 'boolean' }, setup: { type: 'boolean' }, check: { type: 'boolean' },
    model: { type: 'string' },
    'model-reasoning-effort': { type: 'string' },
  } });
  if (values.model !== undefined && !values.model.trim()) throw new Error('--model must be a nonempty model ID');
  const effort = values['model-reasoning-effort'];
  if (effort !== undefined && !effort.trim()) throw new Error('--model-reasoning-effort must be nonempty');
  return { ...values, ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(effort === undefined ? {} : { modelReasoningEffort: effort.trim() }) };
}

export function startupOverrides(agent: AgentConfig, args: ModelOverrides): ModelOverrides {
  const model = args.model ?? agent.model;
  const modelReasoningEffort = args.modelReasoningEffort ?? agent.modelReasoningEffort;
  if ((model !== undefined || modelReasoningEffort !== undefined) && agent.driver !== 'codex') throw new Error('Model and reasoning effort overrides require the Codex driver');
  return { ...(model === undefined ? {} : { model }),
    ...(modelReasoningEffort === undefined ? {} : { modelReasoningEffort }) };
}
