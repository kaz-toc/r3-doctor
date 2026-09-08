import path from 'node:path';

import { Command } from 'commander';

import { R3DoctorError } from '../shared/errors.js';
import { createOneShotAcpClient } from '../semantic/acp/acp-client.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from '../semantic/acp/provider-registry.js';
import { normalizeProviderId } from '../semantic/provider.js';

export type LlmInspectOptions = {
  provider?: string;
  path: string;
};

export type LlmInspectResult = {
  exitCode: 0 | 1 | 2;
  stderr: string;
};

export async function runLlmInspect(options: LlmInspectOptions): Promise<LlmInspectResult> {
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

  if (result.ok) {
    const lines = [`provider=${providerId} status=available`];
    if (result.value.agentInfo) {
      lines.push(
        `agent=${result.value.agentInfo.name}${result.value.agentInfo.version ? `@${result.value.agentInfo.version}` : ''}`,
      );
    }
    lines.push(`authMethods=${result.value.authMethods.map((method) => method.id).join(',') || 'none'}`);
    return { exitCode: 0, stderr: `${lines.join('\n')}\n` };
  }

  const lines = [
    `provider=${providerId} status=unavailable reason=${result.reason}`,
    `installHint=${definition.installHint}`,
  ];
  return {
    exitCode: result.reason === 'executable_missing' ? 1 : 2,
    stderr: `${lines.join('\n')}\n`,
  };
}

export function registerLlmInspectCommand(program: Command): void {
  const llm = program.command('llm').description('LLM provider utilities');

  llm
    .command('inspect')
    .description('inspect configured LLM provider availability')
    .option('--provider <id>', 'provider id (copilot|cursor|codex|claude|openai|anthropic)')
    .option('--path <path>', 'repository path used as ACP runtime directory', process.cwd())
    .action(async (options: { provider?: string; path: string }) => {
      const result = await runLlmInspect(options);
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });
}
