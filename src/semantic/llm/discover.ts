import path from 'node:path';

import { createOneShotAcpClient } from '../acp/acp-client.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from '../acp/provider-registry.js';
import type { LlmProviderId, LlmResult } from '../acp/provider-types.js';

import { resolveLlmRuntimeDirectory } from './runtime-directory.js';

export type LlmDiscoveredModels = {
  models: readonly string[];
  defaultModelIdentifier: string;
};

export type LlmModelChoice = {
  modelIdentifier: string;
  label: string;
};

export function llmModelChoiceLabel(modelIdentifier: string): string {
  const trimmed = modelIdentifier.trim();
  return trimmed;
}

export function toLlmModelChoices(modelIdentifiers: readonly string[]): LlmModelChoice[] {
  const choices: LlmModelChoice[] = [];
  const seen = new Set<string>();
  for (const identifier of modelIdentifiers) {
    const normalized = identifier.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    choices.push({
      modelIdentifier: normalized,
      label: llmModelChoiceLabel(normalized),
    });
  }
  return choices;
}

export function buildDiscoveredModels(
  providerId: LlmProviderId,
  advertised: readonly string[],
): LlmDiscoveredModels {
  const filtered = advertised.filter((value) => value !== '');

  if (providerId === 'copilot') {
    const models = filtered.includes('auto') ? filtered : ['auto', ...filtered];
    return {
      models,
      defaultModelIdentifier: 'auto',
    };
  }

  if (filtered.length === 0) {
    return {
      models: [''],
      defaultModelIdentifier: '',
    };
  }

  return {
    models: ['', ...filtered],
    defaultModelIdentifier: '',
  };
}

/** Provider を起動せずに提示できるモデル。Copilot は auto のみ、他は provider 既定のみ。 */
export function knownLlmModelChoices(providerId: LlmProviderId): LlmDiscoveredModels {
  return buildDiscoveredModels(providerId, providerId === 'copilot' ? ['auto'] : []);
}

export async function discoverLlmModels(input: {
  provider: LlmProviderId;
  path?: string;
  setupTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LlmResult<LlmDiscoveredModels>> {
  const definition = getLlmProviderDefinition(input.provider);
  const runtimeDirectory = path.resolve(input.path ?? resolveLlmRuntimeDirectory());
  const spec = buildLlmLaunchSpec(input.provider, {
    executablePath: definition.defaultExecutablePath,
    modelIdentifier: input.provider === 'copilot' ? 'auto' : '',
    runtimeDirectory,
    inheritedEnv: process.env,
  });

  const client = createOneShotAcpClient({ setupTimeoutMs: input.setupTimeoutMs });
  const result = await client.discoverModels({ spec, signal: input.signal });
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: buildDiscoveredModels(input.provider, result.value.advertised),
  };
}
