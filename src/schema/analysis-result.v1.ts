import { z } from 'zod';

import { diagnosisReportSchema, diffReportSchema } from './report.v1.js';
import {
  securityAssessmentSchema,
  securityCoverageSchema,
  securityFingerprintsSchema,
  securityReasonsSchema,
  securityScopeSchema,
  SECURITY_CONTRACT_LIMITS,
} from './security-assessment.v1.js';

export const ANALYSIS_RESULT_SCHEMA_VERSION = 1;
export const ANALYSIS_RESULT_KIND = 'r3-doctor-analysis';
export const SECURITY_DRY_RUN_SCHEMA_VERSION = 1;
export const SECURITY_DRY_RUN_KIND = 'r3-doctor-security-dry-run';

/** Upper bounds shared with the security execution policy (maxBatches 1..16, 8 units per batch). */
export const SECURITY_PLAN_LIMITS = {
  batches: 16,
  unitsPerBatch: 8,
} as const;

const addonsSchema = z.object({ security: securityAssessmentSchema }).strict();

const scanAnalysisResultSchema = z
  .object({
    schemaVersion: z.literal(ANALYSIS_RESULT_SCHEMA_VERSION),
    kind: z.literal(ANALYSIS_RESULT_KIND),
    mode: z.literal('scan'),
    core: diagnosisReportSchema,
    addons: addonsSchema,
  })
  .strict();

const diffAnalysisResultSchema = z
  .object({
    schemaVersion: z.literal(ANALYSIS_RESULT_SCHEMA_VERSION),
    kind: z.literal(ANALYSIS_RESULT_KIND),
    mode: z.literal('diff'),
    core: diffReportSchema,
    addons: addonsSchema,
  })
  .strict();

/** Opt-in envelope returned only when the security add-on was requested for the run. */
export const analysisResultSchema = z
  .discriminatedUnion('mode', [scanAnalysisResultSchema, diffAnalysisResultSchema])
  .superRefine((result, ctx) => {
    if (result.addons.security.scope.mode !== result.mode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'security scope mode must match the envelope mode',
        path: ['addons', 'security', 'scope', 'mode'],
      });
    }
  });

export const securityDryRunBatchSchema = z
  .object({
    batchId: z.string().regex(/^batch:[0-9]{1,4}$/),
    unitCount: z.number().int().positive().max(SECURITY_PLAN_LIMITS.unitsPerBatch),
    fileCount: z.number().int().nonnegative(),
    promptBytes: z.number().int().positive(),
  })
  .strict();

/** Local planning summary. It never carries source text, secret values, or raw prompts. */
export const securityDryRunSchema = z
  .object({
    schemaVersion: z.literal(SECURITY_DRY_RUN_SCHEMA_VERSION),
    kind: z.literal(SECURITY_DRY_RUN_KIND),
    status: z.enum(['planned', 'disabled', 'blocked', 'unavailable', 'failed']),
    reasons: securityReasonsSchema,
    scope: securityScopeSchema,
    coverage: securityCoverageSchema,
    batches: z.array(securityDryRunBatchSchema).max(SECURITY_PLAN_LIMITS.batches),
    fingerprints: securityFingerprintsSchema.pick({ policy: true, input: true }),
    limitations: z
      .array(z.string().min(1).max(SECURITY_CONTRACT_LIMITS.narrativeChars))
      .max(SECURITY_CONTRACT_LIMITS.narrativeItems),
  })
  .strict()
  .superRefine((dryRun, ctx) => {
    if (dryRun.status !== 'planned' && dryRun.batches.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${dryRun.status} dry-run must not plan batches`,
        path: ['batches'],
      });
    }
    if (dryRun.status !== 'planned' && dryRun.status !== 'disabled' && dryRun.reasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${dryRun.status} dry-run requires at least one reason code`,
        path: ['reasons'],
      });
    }
  });

export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type SecurityDryRun = z.infer<typeof securityDryRunSchema>;
export type SecurityDryRunBatch = z.infer<typeof securityDryRunBatchSchema>;
