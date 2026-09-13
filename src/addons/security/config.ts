import { z } from 'zod';

export const securityScopeSettingSchema = z.enum(['repository', 'changed']);

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
