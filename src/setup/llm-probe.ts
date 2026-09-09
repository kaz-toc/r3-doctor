import { SETUP_LLM_PROBE_TIMEOUT_MS } from '../semantic/acp/constants.js';
import { listSetupLlmProviderOptions } from '../semantic/acp/provider-registry.js';
import { buildLlmCatalog } from '../semantic/llm/catalog.js';
import { resolveLlmRuntimeDirectory } from '../semantic/llm/runtime-directory.js';
import type { LlmCatalogReport } from '../schema/llm-catalog.v1.js';

import type { SetupLlmProviderId } from './llm-providers.js';

export type ProbeSetupLlmProvidersOptions = {
  inspectTimeoutMs?: number;
  onProgress?: (info: { provider: string; displayName: string; current: number; total: number }) => void;
};

export async function probeSetupLlmProviders(
  options: ProbeSetupLlmProvidersOptions = {},
): Promise<LlmCatalogReport> {
  return buildLlmCatalog({
    inspect: true,
    path: resolveLlmRuntimeDirectory(),
    setupOrder: true,
    inspectTimeoutMs: options.inspectTimeoutMs ?? SETUP_LLM_PROBE_TIMEOUT_MS,
    onInspectProgress: options.onProgress
      ? ({ providerId, displayName, current, total }) =>
          options.onProgress?.({ provider: providerId, displayName, current, total })
      : undefined,
  });
}

export function toAvailableSetupProviderOptions(
  catalog: LlmCatalogReport,
): ReadonlyArray<{ value: SetupLlmProviderId; label: string }> {
  const order = new Map(
    listSetupLlmProviderOptions().map((option, index) => [option.value, index]),
  );
  return [...catalog.providers]
    .filter((provider) => provider.inspect.status === 'available')
    .sort((left, right) => (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99))
    .map((provider) => ({
      value: provider.id as SetupLlmProviderId,
      label: provider.displayName,
    }));
}

export function findCatalogProvider(
  catalog: LlmCatalogReport,
  providerId: SetupLlmProviderId,
) {
  return catalog.providers.find((provider) => provider.id === providerId);
}
