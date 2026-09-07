import { createOneShotAcpClient } from '../acp/acp-client.js';
import { LLM_PROMPT_OUTPUT_MAX_BYTES } from '../acp/constants.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from '../acp/provider-registry.js';
import type { LlmProviderId } from '../acp/provider-types.js';
import type { LlmSpawn } from '../acp/process-port.js';
import type { RepositorySnapshot } from '../../intake/snapshot.js';
import type { Evidence } from '../../schema/report.v1.js';
import type { LlmConfig } from '../../shared/config.js';
import type { SemanticProvider } from '../types.js';
import { buildBudgetedSemanticPrompt } from '../semantic-prompt.js';
import { parseSemanticResponse } from '../semantic-response.js';

export const SEMANTIC_PROVIDER_IMPL_VERSION = '2.1.0';

export class AcpSemanticProvider implements SemanticProvider {
  readonly name: LlmProviderId;
  readonly implementationVersion = SEMANTIC_PROVIDER_IMPL_VERSION;

  constructor(
    providerId: LlmProviderId,
    private readonly config: LlmConfig,
    private readonly spawn?: LlmSpawn,
  ) {
    this.name = providerId;
  }

  async analyze(snapshot: RepositorySnapshot, evidence: Evidence[]): Promise<unknown> {
    const maxPromptBytes = this.config.maxPromptBytes ?? 80_000;
    const { prompt } = buildBudgetedSemanticPrompt(snapshot, evidence, maxPromptBytes);
    const definition = getLlmProviderDefinition(this.name);
    const executablePath = this.config.executablePath ?? definition.defaultExecutablePath;
    const spec = buildLlmLaunchSpec(this.name, {
      executablePath,
      modelIdentifier: this.config.model ?? (this.name === 'copilot' ? 'auto' : ''),
      runtimeDirectory: snapshot.repositoryPath,
      inheritedEnv: process.env,
    });

    const client = createOneShotAcpClient({ spawn: this.spawn });
    const result = await client.oneShotPrompt({
      spec,
      prompt,
      outputMaxBytes: LLM_PROMPT_OUTPUT_MAX_BYTES,
      modelIdentifier: this.config.model,
    });

    if (!result.ok) {
      throw new Error(result.reason);
    }

    return parseSemanticResponse(result.value.text);
  }
}
