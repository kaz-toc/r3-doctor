import path from 'node:path';

import { createOneShotAcpClient } from '../acp/acp-client.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from '../acp/provider-registry.js';
import { normalizeProviderId } from '../provider-ids.js';
import { R3DoctorError } from '../../shared/errors.js';

import { formatLlmInspectStderr } from './format.js';
import type { LlmInspectExitCode, LlmProviderInspectRow } from './types.js';

export type InspectLlmProviderOptions = {
  provider?: string;
  path: string;
};

export type InspectLlmProviderResult = {
  exitCode: LlmInspectExitCode;
  stderr: string;
  row: LlmProviderInspectRow;
};

function exitCodeForInspectRow(row: LlmProviderInspectRow): LlmInspectExitCode {
  if (row.status === 'available') {
    return 0;
  }
  return row.reason === 'executable_missing' ? 1 : 2;
}

export async function inspectLlmProvider(
  options: InspectLlmProviderOptions,
): Promise<InspectLlmProviderResult> {
  const providerRaw = options.provider ?? 'codex';
  const providerId = normalizeProviderId(providerRaw);
  if (!providerId || providerId === 'none') {
    throw new R3DoctorError(`invalid provider: ${providerRaw}`);
  }

  const definition = getLlmProviderDefinition(providerId);
  const repositoryPath = path.resolve(options.path);
  const spec = buildLlmLaunchSpec(providerId, {
    executablePath: definition.defaultExecutablePath,
    modelIdentifier: providerId === 'copilot' ? 'auto' : '',
    runtimeDirectory: repositoryPath,
    inheritedEnv: process.env,
  });

  const client = createOneShotAcpClient();
  const result = await client.inspect({ spec });

  const row: LlmProviderInspectRow = result.ok
    ? {
        providerId,
        status: 'available',
        agentInfo: result.value.agentInfo,
        authMethods: result.value.authMethods.map((method) => method.id),
        installHint: definition.installHint,
      }
    : {
        providerId,
        status: 'unavailable',
        reason: result.reason,
        authMethods: [],
        installHint: definition.installHint,
      };

  return {
    exitCode: exitCodeForInspectRow(row),
    stderr: formatLlmInspectStderr(row),
    row,
  };
}

/** @deprecated Prefer inspectLlmProvider; kept for setup/check callers. */
export async function runLlmInspect(options: InspectLlmProviderOptions): Promise<{
  exitCode: LlmInspectExitCode;
  stderr: string;
  row?: LlmProviderInspectRow;
}> {
  const result = await inspectLlmProvider(options);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    row: result.row,
  };
}
