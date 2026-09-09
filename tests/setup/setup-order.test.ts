import { describe, expect, it } from 'vitest';

import { listSetupLlmProviderOptions } from '../../src/semantic/acp/provider-registry.js';
import { SETUP_LLM_PROVIDER_OPTIONS } from '../../src/setup/llm-providers.js';

describe('setup LLM provider order', () => {
  it('derives setup options in codex → claude → cursor → copilot order', () => {
    const values = SETUP_LLM_PROVIDER_OPTIONS.map((option) => option.value);
    expect(values).toEqual(['codex', 'claude', 'cursor', 'copilot']);
    expect(listSetupLlmProviderOptions().map((option) => option.value)).toEqual(values);
  });
});
