import path from 'node:path';

import {
  listLlmProviderDefinitions,
  listSetupOrderedLlmProviderDefinitions,
} from '../acp/provider-registry.js';
import { normalizeProviderId } from '../provider-ids.js';
import {
  defaultOperatorProfilePath,
  loadOperatorProfile,
} from '../../operator/profile.js';
import { R3DoctorError } from '../../shared/errors.js';
import {
  llmCatalogInspectSchema,
  llmCatalogReportSchema,
  type LlmCatalogInspect,
  type LlmCatalogReport,
} from '../../schema/llm-catalog.v1.js';

import { listAliasesForProvider } from './aliases.js';
import { inspectLlmProvider } from './inspect.js';

export type BuildLlmCatalogOptions = {
  inspect?: boolean;
  provider?: string;
  path?: string;
  profilePath?: string;
  inspectTimeoutMs?: number;
  onInspectProgress?: (info: { providerId: string; displayName: string; current: number; total: number }) => void;
  setupOrder?: boolean;
};

function formatAgent(agentInfo?: { name: string; version?: string }): string | undefined {
  if (!agentInfo) {
    return undefined;
  }
  return `${agentInfo.name}${agentInfo.version ? `@${agentInfo.version}` : ''}`;
}

export async function buildLlmCatalog(options: BuildLlmCatalogOptions = {}): Promise<LlmCatalogReport> {
  const definitions = options.setupOrder
    ? listSetupOrderedLlmProviderDefinitions()
    : listLlmProviderDefinitions();
  let selected = [...definitions];

  if (options.provider) {
    const providerId = normalizeProviderId(options.provider);
    if (!providerId || providerId === 'none') {
      throw new R3DoctorError(`invalid provider: ${options.provider}`);
    }
    selected = definitions.filter((definition) => definition.id === providerId);
  }

  const profilePath = options.profilePath ?? defaultOperatorProfilePath();
  const profile = await loadOperatorProfile(profilePath);
  const repositoryPath = path.resolve(options.path ?? process.cwd());

  const providers = [];
  for (const [index, definition] of selected.entries()) {
    let inspect: LlmCatalogInspect = { status: 'skipped' };
    if (options.inspect) {
      options.onInspectProgress?.({
        providerId: definition.id,
        displayName: definition.displayName,
        current: index + 1,
        total: selected.length,
      });
      const result = await inspectLlmProvider({
        provider: definition.id,
        path: repositoryPath,
        setupTimeoutMs: options.inspectTimeoutMs,
      });
      inspect = result.row.status === 'available'
        ? {
            status: 'available' as const,
            agent: formatAgent(result.row.agentInfo),
            authMethods: [...result.row.authMethods],
          }
        : {
            status: 'unavailable' as const,
            reason: result.row.reason,
          };
    }

    providers.push({
      id: definition.id,
      displayName: definition.displayName,
      aliases: [...listAliasesForProvider(definition.id)],
      defaultExecutable: definition.defaultExecutablePath,
      installHint: definition.installHint,
      inspect,
    });
  }

  const operatorDefault = profile?.llm?.provider && profile.llm.provider !== 'none'
    ? {
        provider: profile.llm.provider,
        profilePath,
      }
    : undefined;

  return llmCatalogReportSchema.parse({
    schemaVersion: 1,
    providers,
    ...(operatorDefault ? { operatorDefault } : {}),
  });
}
