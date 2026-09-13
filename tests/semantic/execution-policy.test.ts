import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLlmExecutionPolicy } from '../../src/semantic/execution-policy.js';

describe('operator-owned LLM execution policy', () => {
  it.each([undefined, 'none'] as const)('REG-2026-030 keeps a partial profile with provider %s inactive until selected', (provider) => {
    const profile = { schemaVersion: 1 as const, llm: {
      provider, model: 'model-id', sendScope: 'changed' as const, maxFiles: 2,
    } };
    expect(parseLlmExecutionPolicy({}, false, profile)).toMatchObject({
      enabled: false, provider: 'none', sendScope: 'changed', maxFiles: 2,
    });
    expect(parseLlmExecutionPolicy({ llmProvider: 'codex' }, false, profile)).toMatchObject({
      enabled: true, provider: 'codex', model: 'model-id', sendScope: 'changed', maxFiles: 2,
    });
  });

  it.each([
    ['model', { llmModel: 'model-id' }],
    ['executable', { llmExecutable: path.resolve('provider') }],
  ])('REG-2026-012 rejects a provider-less %s override during dry-run', (_name, override) => {
    expect(() => parseLlmExecutionPolicy(override, true)).toThrow('requires --llm-provider');
  });

  it('allows provider-less scope and resource limits during dry-run', () => {
    const policy = parseLlmExecutionPolicy({
      llmSendScope: 'changed',
      llmMaxFiles: '2',
      llmMaxPromptBytes: '4096',
    }, true);

    expect(policy).toMatchObject({
      enabled: false,
      provider: 'none',
      sendScope: 'changed',
      maxFiles: 2,
      maxPromptBytes: 4096,
    });
  });

  it('rejects a relative executable even when a provider is selected', () => {
    expect(() => parseLlmExecutionPolicy({
      llmProvider: 'codex',
      llmExecutable: './provider',
    })).toThrow('absolute path or a bare command name');
  });
});
