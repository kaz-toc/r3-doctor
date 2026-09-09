import { describe, expect, it } from 'vitest';

import {
  buildDiscoveredModels,
  knownLlmModelChoices,
  toLlmModelChoices,
} from '../../src/semantic/llm/discover.js';

describe('llm model discovery helpers', () => {
  it('builds copilot choices with auto first', () => {
    expect(buildDiscoveredModels('copilot', ['gpt-4.1'])).toEqual({
      models: ['auto', 'gpt-4.1'],
      defaultModelIdentifier: 'auto',
    });
  });

  it('builds non-copilot choices with provider default first', () => {
    expect(buildDiscoveredModels('codex', ['gpt-4.1', 'gpt-4.1-mini'])).toEqual({
      models: ['', 'gpt-4.1', 'gpt-4.1-mini'],
      defaultModelIdentifier: '',
    });
  });

  it('falls back to known static choices', () => {
    expect(knownLlmModelChoices('copilot')).toEqual({
      models: ['auto'],
      defaultModelIdentifier: 'auto',
    });
    expect(knownLlmModelChoices('codex')).toEqual({
      models: [''],
      defaultModelIdentifier: '',
    });
  });

  it('deduplicates model choices for UI', () => {
    expect(toLlmModelChoices(['', 'gpt-4.1', 'gpt-4.1'])).toEqual([
      { modelIdentifier: '', label: '' },
      { modelIdentifier: 'gpt-4.1', label: 'gpt-4.1' },
    ]);
  });
});
