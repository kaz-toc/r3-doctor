import type { LlmProviderId } from '../acp/provider-types.js';

export const LLM_PROVIDER_ALIASES: Readonly<Record<string, LlmProviderId>> = {
  openai: 'codex',
  anthropic: 'claude',
};

export function resolveProviderAlias(value: string): string {
  return LLM_PROVIDER_ALIASES[value] ?? value;
}

export function listAliasesForProvider(id: LlmProviderId): readonly string[] {
  return Object.entries(LLM_PROVIDER_ALIASES)
    .filter(([, target]) => target === id)
    .map(([alias]) => alias);
}
