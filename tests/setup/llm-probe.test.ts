import { describe, expect, it } from 'vitest';

import type { LlmCatalogReport } from '../../src/schema/llm-catalog.v1.js';
import { toAvailableSetupProviderOptions } from '../../src/setup/llm-probe.js';

describe('setup LLM probe helpers', () => {
  it('filters available providers and preserves setup order', () => {
    const catalog: LlmCatalogReport = {
      schemaVersion: 1,
      providers: [
        {
          id: 'copilot',
          displayName: 'GitHub Copilot',
          aliases: [],
          defaultExecutable: 'copilot',
          installHint: 'hint',
          inspect: { status: 'available', authMethods: [] },
        },
        {
          id: 'codex',
          displayName: 'OpenAI Codex',
          aliases: ['openai'],
          defaultExecutable: 'codex-acp',
          installHint: 'hint',
          inspect: { status: 'available', authMethods: [] },
        },
        {
          id: 'claude',
          displayName: 'Claude',
          aliases: ['anthropic'],
          defaultExecutable: 'claude-agent-acp',
          installHint: 'hint',
          inspect: { status: 'unavailable', reason: 'executable_missing' },
        },
      ],
    };

    expect(toAvailableSetupProviderOptions(catalog).map((option) => option.value)).toEqual(['codex', 'copilot']);
  });
});
