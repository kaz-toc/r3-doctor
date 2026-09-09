import { listSetupLlmProviderOptions } from '../semantic/acp/provider-registry.js';
import type { LlmConfig } from '../shared/config.js';

export const SETUP_LLM_PROVIDER_OPTIONS = listSetupLlmProviderOptions() as ReadonlyArray<{
  value: Exclude<LlmConfig['provider'], 'none'>;
  label: string;
}>;

export type SetupLlmProviderId = (typeof SETUP_LLM_PROVIDER_OPTIONS)[number]['value'];
