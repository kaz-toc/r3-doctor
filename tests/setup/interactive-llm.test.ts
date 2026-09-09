import { describe, expect, it, vi } from 'vitest';

import { runInteractiveSetupChoices } from '../../src/setup/interactive.js';

describe('interactive setup LLM flow', () => {
  it('defers when no providers are available', async () => {
    vi.spyOn(await import('../../src/setup/prompts.js'), 'createSetupPrompts').mockResolvedValue({
      selectLocale: async () => 'en',
      confirm: async (message: string) => {
        if (message.includes('Configure LLM provider')) return true;
        if (message.includes('Create r3-doctor.config.json')) return true;
        return false;
      },
      selectProvider: async () => 'codex',
      selectModel: async () => '',
      close: async () => undefined,
    });
    vi.spyOn(await import('../../src/setup/llm-probe.js'), 'probeSetupLlmProviders').mockResolvedValue({
      schemaVersion: 1,
      providers: [
        {
          id: 'codex',
          displayName: 'OpenAI Codex',
          aliases: ['openai'],
          defaultExecutable: 'codex-acp',
          installHint: 'hint',
          inspect: { status: 'unavailable', reason: 'executable_missing' },
        },
      ],
    });

    const choices = await runInteractiveSetupChoices('/tmp/repo', {});
    expect(choices.configureLlm).toBe(true);
    expect(choices.llmInspectAvailable).toBe(false);
    expect(choices.llmProvider).toBeUndefined();
  });
});
