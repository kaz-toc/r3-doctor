import type { LlmConfig } from '../shared/config.js';

export const SETUP_LLM_PROVIDER_OPTIONS = [
  { value: 'codex' as const, label: 'OpenAI Codex' },
  { value: 'claude' as const, label: 'Claude' },
  { value: 'cursor' as const, label: 'Cursor' },
  { value: 'copilot' as const, label: 'GitHub Copilot' },
] satisfies ReadonlyArray<{ value: Exclude<LlmConfig['provider'], 'none'>; label: string }>;

export type SetupLlmProviderId = (typeof SETUP_LLM_PROVIDER_OPTIONS)[number]['value'];
