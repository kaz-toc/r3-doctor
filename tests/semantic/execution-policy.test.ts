import { describe, expect, it } from 'vitest';

import { parseLlmExecutionPolicy } from '../../src/semantic/execution-policy.js';

describe('operator-owned LLM execution policy', () => {
  it.each([
    ['model', { llmModel: 'model-id' }],
    ['executable', { llmExecutable: './provider' }],
  ])('REG-2026-001 rejects a provider-less %s override during dry-run', (_name, override) => {
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
});
