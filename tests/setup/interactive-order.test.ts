import { describe, expect, it, vi } from 'vitest';

import { runInteractiveSetupChoices } from '../../src/setup/interactive.js';

describe('interactive setup prompt order', () => {
  it('REG-2026-025: asks about the first scan after LLM configuration', async () => {
    const confirmationMessages: string[] = [];
    vi.spyOn(await import('../../src/setup/prompts.js'), 'createSetupPrompts').mockResolvedValue({
      selectLocale: async () => 'en',
      confirm: async (message: string) => {
        confirmationMessages.push(message);
        if (message.includes('Create r3-doctor.config.json')) return true;
        return false;
      },
      selectProvider: async () => 'codex',
      selectModel: async () => '',
      close: async () => undefined,
    });

    await runInteractiveSetupChoices('/tmp/r3-doctor-prompt-order', {});

    const configureLlmIndex = confirmationMessages.findIndex((message) =>
      message.includes('Configure LLM provider'),
    );
    const runScanIndex = confirmationMessages.findIndex((message) =>
      message.includes('Run first scan now'),
    );

    expect(configureLlmIndex).toBeGreaterThanOrEqual(0);
    expect(runScanIndex).toBeGreaterThan(configureLlmIndex);
  });
});
