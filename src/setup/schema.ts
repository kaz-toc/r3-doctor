import { z } from 'zod';

import { reportLocaleSchema } from '../shared/config.js';

const checkItemSchema = z
  .object({
    ok: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();

export const checkReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    locale: reportLocaleSchema,
    repositoryPath: z.string(),
    ready: z.boolean(),
    checks: z
      .object({
        node: checkItemSchema,
        git: checkItemSchema,
        config: checkItemSchema,
        baseline: checkItemSchema,
        llm: checkItemSchema.optional(),
      })
      .strict(),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .strict();

export type CheckReport = z.infer<typeof checkReportSchema>;

export const setupReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    locale: reportLocaleSchema,
    repositoryPath: z.string(),
    dryRun: z.boolean(),
    configSkipped: z.boolean(),
    configWritten: z.boolean(),
    configPath: z.string(),
    detected: z
      .object({
        workspaces: z.array(z.string()),
        suggestedExclude: z.array(z.string()),
        hasGitignore: z.boolean(),
      })
      .strict(),
    nextSteps: z.array(z.string()),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const forbiddenKeys = ['llm', 'executablePath', 'provider'] as const;
    for (const key of forbiddenKeys) {
      if (key in (value as Record<string, unknown>)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `forbidden key: ${key}` });
      }
    }
  });

export type SetupReport = z.infer<typeof setupReportSchema>;
