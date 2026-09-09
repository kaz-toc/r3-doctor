import { afterEach, describe, expect, it, vi } from 'vitest';

import { runInteractiveSetupChoices } from '../../src/setup/interactive.js';

describe('interactive setup LLM flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('REG-2026-026: shows the requested operator profile path before saving', async () => {
    const confirmations: string[] = [];
    vi.spyOn(await import('../../src/setup/prompts.js'), 'createSetupPrompts').mockResolvedValue({
      selectLocale: async () => 'en',
      confirm: async (message: string) => {
        confirmations.push(message);
        if (message.includes('Run first scan')) return false;
        return true;
      },
      selectProvider: async () => 'codex',
      selectModel: async () => '',
      close: async () => undefined,
    });
    vi.spyOn(await import('../../src/setup/llm-probe.js'), 'probeSetupLlmProviders').mockResolvedValue({
      schemaVersion: 1,
      providers: [{
        id: 'codex',
        displayName: 'OpenAI Codex',
        aliases: ['openai'],
        defaultExecutable: 'codex-acp',
        installHint: 'hint',
        inspect: { status: 'available', authMethods: [] },
      }],
    });
    vi.spyOn(await import('../../src/semantic/llm/discover.js'), 'discoverLlmModels').mockResolvedValue({
      ok: true,
      value: { models: [''], defaultModelIdentifier: '' },
    });
    const profilePath = '/tmp/custom profiles/operator.json';

    await runInteractiveSetupChoices('/tmp/repo', { profilePath });

    expect(confirmations).toContain(
      `Save provider as default in operator profile (${profilePath})?`,
    );
  });
});
