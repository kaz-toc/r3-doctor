import path from 'node:path';

import { z } from 'zod';

export const securityScopeSettingSchema = z.enum(['repository', 'changed']);

export const OPERATOR_SECURITY_LIMITS = {
  repositories: 128,
  repositoryPathChars: 1_024,
  maxBatches: { min: 1, max: 16 },
  maxTotalPromptBytes: { min: 1, max: 2_000_000 },
  timeoutMs: { min: 1_000, max: 600_000 },
} as const;

/**
 * Operator-owned consent and budget. Repository roots are absolute and are matched exactly
 * after the trusted profile loader canonicalizes them; out-of-range budgets are rejected, not rounded.
 */
export const operatorSecuritySettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    repositories: z
      .array(
        z
          .string()
          .min(1)
          .max(OPERATOR_SECURITY_LIMITS.repositoryPathChars)
          .refine((value) => path.isAbsolute(value), { message: 'repository roots must be absolute paths' }),
      )
      .max(OPERATOR_SECURITY_LIMITS.repositories)
      .default([]),
    scope: securityScopeSettingSchema.optional(),
    maxBatches: z
      .number()
      .int()
      .min(OPERATOR_SECURITY_LIMITS.maxBatches.min)
      .max(OPERATOR_SECURITY_LIMITS.maxBatches.max)
      .optional(),
    maxTotalPromptBytes: z
      .number()
      .int()
      .min(OPERATOR_SECURITY_LIMITS.maxTotalPromptBytes.min)
      .max(OPERATOR_SECURITY_LIMITS.maxTotalPromptBytes.max)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(OPERATOR_SECURITY_LIMITS.timeoutMs.min)
      .max(OPERATOR_SECURITY_LIMITS.timeoutMs.max)
      .optional(),
  })
  .strict();

export const operatorAddonSettingsSchema = z
  .object({
    security: operatorSecuritySettingsSchema.optional(),
  })
  .strict();

export type OperatorSecuritySettings = z.infer<typeof operatorSecuritySettingsSchema>;

/**
 * Repository-owned request only. It never grants execution, provider selection, send scope,
 * or limits; those remain operator-owned (ADR 0003, ADR 0006).
 */
export const repositorySecurityDeclarationSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: securityScopeSettingSchema.optional(),
  })
  .strict();

export const repositoryAddonDeclarationsSchema = z
  .object({
    security: repositorySecurityDeclarationSchema.optional(),
  })
  .strict();

export type RepositorySecurityDeclaration = z.infer<typeof repositorySecurityDeclarationSchema>;
export type RepositoryAddonDeclarations = z.infer<typeof repositoryAddonDeclarationsSchema>;
