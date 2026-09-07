import { z } from 'zod';

export function normalizeProviderAlias(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'openai') return 'codex';
  if (value === 'anthropic') return 'claude';
  return value;
}

export const llmProviderSchema = z.preprocess(
  normalizeProviderAlias,
  z.enum(['none', 'copilot', 'cursor', 'codex', 'claude']),
);

export const llmConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: llmProviderSchema.default('none'),
    model: z.string().trim().min(1).optional(),
    executablePath: z.string().trim().min(1).optional(),
    maxPromptBytes: z.number().int().positive().max(1_000_000).default(80_000),
    maxFiles: z.number().int().positive().max(100).default(20),
    sendScope: z.enum(['changed', 'cluster-context', 'all']).default('cluster-context'),
  })
  .strict();

export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const defaultLlmConfig: LlmConfig = llmConfigSchema.parse({});

export const repositoryConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    exclude: z
      .array(z.string().max(256))
      .max(128)
      .refine((patterns) => patterns.reduce((total, pattern) => total + pattern.length, 0) <= 16_384, {
        message: 'exclude patterns exceed total character limit',
      })
      .default(['node_modules', 'dist', 'build', 'coverage']),
    maxFiles: z.number().int().positive().max(50_000).default(5000),
    maxFileLines: z.number().int().positive().max(100_000).default(800),
    fanOutThreshold: z.number().int().positive().max(100_000).default(8),
    fanInThreshold: z.number().int().positive().max(100_000).default(8),
    churnDays: z.number().int().positive().max(36_500).default(90),
    baselineDir: z.string().max(1_024).default('.r3-doctor/baselines'),
    trendDir: z.string().max(1_024).default('.r3-doctor/trends'),
    policyFile: z.string().max(1_024).default('.r3-doctor/policy.json'),
    units: z
      .array(
        z
          .object({
            id: z.string().max(256),
            roots: z.array(z.string().max(1_024)).min(1).max(1_000),
          })
          .strict(),
      )
      .max(1_000)
      .default([]),
    diagnosticSkipRoots: z.array(z.string().max(1_024)).max(1_000).default([]),
  })
  .strict();

export const configSchema = repositoryConfigSchema.extend({ llm: llmConfigSchema }).strict();

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

export type R3DoctorConfig = z.infer<typeof configSchema>;

export const defaultConfig: R3DoctorConfig = configSchema.parse({
  schemaVersion: 1,
  llm: defaultLlmConfig,
});

export function normalizeConfig(config: R3DoctorConfig): R3DoctorConfig {
  return configSchema.parse(config);
}
