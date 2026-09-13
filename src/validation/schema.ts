import { z } from 'zod';

import { ASSESSMENT_CONTRACT_VERSION, signalIdSchema } from '../schema/report.v1.js';
import { SHADOW_CANDIDATE_IDS } from './shadow-score.js';

const isoTimestampSchema = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, 'must be an ISO-8601 UTC timestamp');

const scoreSchema = z.number().int().min(0).max(100);
const ratioSchema = z.number().min(0).max(1);
const axisScoresSchema = z.object({
  'structural-fragility': scoreSchema.nullable(),
  'change-blast-radius': scoreSchema.nullable(),
  'verification-gap': scoreSchema.nullable(),
  'change-volatility': scoreSchema.nullable(),
  'semantic-ambiguity': scoreSchema.nullable(),
}).strict();

export const repositoryIdSchema = z.string().uuid();
export const sampleIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

const shadowScoreSchema = z.object({
  candidateId: z.enum(SHADOW_CANDIDATE_IDS),
  formulaVersion: z.literal(1),
  score: scoreSchema,
  axisScores: axisScoresSchema,
  scoreBreakdown: z.object({
    core: z.number().min(0).max(100),
    activityUplift: z.number().min(0).max(100),
    clusterUplift: z.number().min(0).max(100),
  }).strict(),
}).strict();

const featureSchema = z.object({
  productPathCount: z.number().int().nonnegative(),
  signalCounts: z.record(signalIdSchema, z.number().int().positive()),
  strengthHistogram: z.object({
    low: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
  }).strict(),
  capabilityCoverage: ratioSchema,
  inputCompleteness: ratioSchema,
}).strict();

export const validationSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  sampleId: sampleIdSchema,
  repositoryId: repositoryIdSchema,
  recordedAt: isoTimestampSchema,
  dueAt: isoTimestampSchema,
  horizonDays: z.number().int().positive(),
  reportInputId: z.string().min(1).max(256),
  headSha: z.string().regex(/^[a-f0-9]{7,64}$/),
  assessmentContractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
  analysisContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policyThresholds: z.object({
    advisory: scoreSchema,
    gate: scoreSchema,
  }).strict().refine((value) => value.advisory <= value.gate, 'advisory must not exceed gate'),
  v4: z.object({
    score: scoreSchema,
    confidence: ratioSchema,
    axisScores: axisScoresSchema,
  }).strict(),
  shadow: z.array(shadowScoreSchema).length(SHADOW_CANDIDATE_IDS.length).superRefine((values, ctx) => {
    const ids = values.map((value) => value.candidateId);
    if (new Set(ids).size !== ids.length || SHADOW_CANDIDATE_IDS.some((candidate) => !ids.includes(candidate))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'shadow candidates must exactly match the registry' });
    }
  }),
  features: featureSchema,
}).strict().superRefine((value, ctx) => {
  if (new Date(value.dueAt).getTime() <= new Date(value.recordedAt).getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'dueAt must be after recordedAt' });
  }
});

export const validationOutcomeKindSchema = z.enum(['regression', 'revert', 'hotfix', 'no-regression']);
export type ValidationOutcomeKind = z.infer<typeof validationOutcomeKindSchema>;

export const validationOutcomeV1Schema = z.object({
  schemaVersion: z.literal(1),
  sampleId: sampleIdSchema,
  observedAt: isoTimestampSchema,
  outcome: validationOutcomeKindSchema,
  occurredAt: isoTimestampSchema.optional(),
  incidentId: z.string().min(1).max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value), 'must not contain control characters').optional(),
}).strict().superRefine((value, ctx) => {
  const positive = value.outcome !== 'no-regression';
  if (positive && !value.occurredAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'positive outcome requires occurredAt' });
  }
  if (!positive && value.occurredAt !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no-regression forbids occurredAt' });
  }
});

export type ValidationSnapshotV1 = z.infer<typeof validationSnapshotV1Schema>;
export type ValidationOutcomeV1 = z.infer<typeof validationOutcomeV1Schema>;
