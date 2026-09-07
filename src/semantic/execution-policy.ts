import path from 'node:path';

import { z } from 'zod';

import {
  defaultLlmConfig,
  llmConfigSchema,
  llmProviderSchema,
  type LlmConfig,
} from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';

export type LlmCliOptions = {
  llmProvider?: string;
  llmModel?: string;
  llmExecutable?: string;
  llmSendScope?: string;
  llmMaxFiles?: string;
  llmMaxPromptBytes?: string;
};

const cliPolicySchema = z
  .object({
    llmProvider: llmProviderSchema.optional(),
    llmModel: z.string().trim().min(1).optional(),
    llmExecutable: z
      .string()
      .trim()
      .min(1)
      .refine((value) => path.isAbsolute(value) || (!value.includes('/') && !value.includes('\\')), {
        message: 'executable must be an absolute path or a bare command name',
      })
      .optional(),
    llmSendScope: z.enum(['changed', 'cluster-context', 'all']).optional(),
    llmMaxFiles: z.coerce.number().int().positive().max(100).optional(),
    llmMaxPromptBytes: z.coerce.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export function parseLlmExecutionPolicy(options: LlmCliOptions, dryRun = false): LlmConfig {
  try {
    const parsed = cliPolicySchema.parse({
      llmProvider: options.llmProvider,
      llmModel: options.llmModel,
      llmExecutable: options.llmExecutable,
      llmSendScope: options.llmSendScope,
      llmMaxFiles: options.llmMaxFiles,
      llmMaxPromptBytes: options.llmMaxPromptBytes,
    });
    const provider = parsed.llmProvider ?? 'none';
    const enabled = provider !== 'none';
    if (!enabled) {
      const providerSpecificOverride = [
        ['--llm-model', parsed.llmModel],
        ['--llm-executable', parsed.llmExecutable],
      ].find((entry) => entry[1] !== undefined);
      const runtimeOverride = [
        ['--llm-send-scope', parsed.llmSendScope],
        ['--llm-max-files', parsed.llmMaxFiles],
        ['--llm-max-prompt-bytes', parsed.llmMaxPromptBytes],
      ].find((entry) => entry[1] !== undefined);
      const forbiddenOverride = providerSpecificOverride ?? (dryRun ? undefined : runtimeOverride);
      if (forbiddenOverride) {
        throw new R3DoctorError(`${forbiddenOverride[0]} requires --llm-provider`);
      }
    }
    if (parsed.llmProvider === 'none') {
      throw new R3DoctorError('--llm-provider must select an external provider');
    }
    return llmConfigSchema.parse({
      ...defaultLlmConfig,
      enabled,
      provider,
      model: parsed.llmModel,
      executablePath: parsed.llmExecutable,
      sendScope: parsed.llmSendScope ?? defaultLlmConfig.sendScope,
      maxFiles: parsed.llmMaxFiles ?? defaultLlmConfig.maxFiles,
      maxPromptBytes: parsed.llmMaxPromptBytes ?? defaultLlmConfig.maxPromptBytes,
    });
  } catch (error) {
    if (error instanceof R3DoctorError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new R3DoctorError(`invalid LLM execution policy: ${reason}`);
  }
}
