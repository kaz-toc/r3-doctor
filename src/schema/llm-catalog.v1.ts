import { z } from 'zod';

import { llmProviderIdSchema } from '../semantic/acp/provider-types.js';

export const llmCatalogInspectSchema = z
  .object({
    status: z.enum(['skipped', 'available', 'unavailable']),
    reason: z.string().optional(),
    agent: z.string().optional(),
    authMethods: z.array(z.string()).optional(),
  })
  .strict();

export type LlmCatalogInspect = z.infer<typeof llmCatalogInspectSchema>;

export const llmCatalogProviderSchema = z
  .object({
    id: llmProviderIdSchema,
    displayName: z.string(),
    aliases: z.array(z.string()),
    defaultExecutable: z.string(),
    installHint: z.string(),
    inspect: llmCatalogInspectSchema,
  })
  .strict();

export const llmCatalogReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z.array(llmCatalogProviderSchema),
    operatorDefault: z
      .object({
        provider: z.string(),
        profilePath: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LlmCatalogReport = z.infer<typeof llmCatalogReportSchema>;
