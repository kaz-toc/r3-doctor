import { z } from 'zod';

import { llmProviderIdSchema } from '../semantic/acp/provider-types.js';

export const SECURITY_ASSESSMENT_SCHEMA_VERSION = 1;
export const SECURITY_ANALYSIS_CONTRACT_VERSION = 1;

/** Security contract v1 limits. Changing a value requires a contract version update. */
export const SECURITY_CONTRACT_LIMITS = {
  pathChars: 1_024,
  titleChars: 200,
  narrativeChars: 4_000,
  narrativeItems: 16,
  cweIdsPerFinding: 8,
  evidenceRefsPerFinding: 16,
  findingsPerAssessment: 256,
  roots: 1_000,
  reasonCodes: 64,
} as const;

export const securityCategorySchema = z.enum([
  'authorization',
  'sql-injection',
  'command-injection',
  'ssrf',
  'path-traversal',
  'xss',
  'deserialization',
  'cryptography',
  'secret-handling',
]);

export const securityRevisionSchema = z.enum(['current', 'base']);
export const securitySeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const securityConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const securityStatusSchema = z.enum(['disabled', 'blocked', 'unavailable', 'failed', 'partial', 'completed']);
export const securityEvidenceRoleSchema = z.enum(['source', 'sink', 'guard', 'context']);
export const securityRelevanceSchema = z.enum(['direct-change', 'related-change']);
export const securityReasonCodeSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const countSchema = z.number().int().nonnegative();
const lineSchema = z.number().int().positive();
const titleSchema = z.string().min(1).max(SECURITY_CONTRACT_LIMITS.titleChars);
const narrativeSchema = z.string().min(1).max(SECURITY_CONTRACT_LIMITS.narrativeChars);
const narrativeListSchema = z.array(narrativeSchema).max(SECURITY_CONTRACT_LIMITS.narrativeItems);
const metadataTextSchema = z.string().min(1).max(256);

function isRepositoryRelativePath(value: string): boolean {
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export const securityRelativePathSchema = z
  .string()
  .min(1)
  .max(SECURITY_CONTRACT_LIMITS.pathChars)
  .refine(isRepositoryRelativePath, { message: 'path must be repository-relative without dot segments' });

const locationShape = {
  path: securityRelativePathSchema,
  revision: securityRevisionSchema,
  startLine: lineSchema,
  endLine: lineSchema,
};

function hasOrderedLines(value: { startLine: number; endLine: number }): boolean {
  return value.startLine <= value.endLine;
}

const lineOrderMessage = { message: 'startLine must not exceed endLine', path: ['endLine'] };

export const securityLocationSchema = z.object(locationShape).strict().refine(hasOrderedLines, lineOrderMessage);

export const securityEvidenceRefSchema = z
  .object({
    ...locationShape,
    snippetId: z.string().regex(/^snippet:[A-Za-z0-9:_-]{1,128}$/),
    role: securityEvidenceRoleSchema,
  })
  .strict()
  .refine(hasOrderedLines, lineOrderMessage);

export const securityFindingIdSchema = z.string().regex(/^security-finding:[a-f0-9]{64}$/);

export const securityFindingSchema = z
  .object({
    findingId: securityFindingIdSchema,
    status: z.literal('candidate'),
    category: securityCategorySchema,
    cweIds: z.array(z.string().regex(/^CWE-[1-9][0-9]*$/)).max(SECURITY_CONTRACT_LIMITS.cweIdsPerFinding),
    severity: securitySeveritySchema,
    severityRationale: narrativeSchema,
    confidence: securityConfidenceSchema,
    confidenceRationale: narrativeSchema,
    title: titleSchema,
    primaryLocation: securityLocationSchema,
    evidenceRefs: z.array(securityEvidenceRefSchema).min(1).max(SECURITY_CONTRACT_LIMITS.evidenceRefsPerFinding),
    preconditions: narrativeListSchema,
    attackPath: narrativeSchema,
    impact: narrativeSchema,
    remediation: narrativeSchema,
    verification: narrativeSchema,
    limitations: narrativeListSchema,
    relevance: securityRelevanceSchema.optional(),
  })
  .strict()
  .superRefine((finding, ctx) => {
    const primary = finding.primaryLocation;
    const covered = finding.evidenceRefs.some((ref) =>
      ref.path === primary.path &&
      ref.revision === primary.revision &&
      ref.startLine <= primary.startLine &&
      primary.endLine <= ref.endLine,
    );
    if (!covered) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primaryLocation must lie within an evidence reference',
        path: ['primaryLocation'],
      });
    }
    if (new Set(finding.cweIds).size !== finding.cweIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cweIds must be unique', path: ['cweIds'] });
    }
  });

const reasonCountsSchema = z
  .record(securityReasonCodeSchema, countSchema)
  .refine((counts) => Object.keys(counts).length <= SECURITY_CONTRACT_LIMITS.reasonCodes, {
    message: 'too many reason codes',
  });

export const securityCoverageSchema = z
  .object({
    eligibleFiles: countSchema,
    selectedFiles: countSchema,
    evaluatedFiles: countSchema,
    eligibleUnits: countSchema,
    selectedUnits: countSchema,
    evaluatedUnits: countSchema,
    excludedByReason: reasonCountsSchema,
    incompleteByReason: reasonCountsSchema,
    intakeTruncated: z.boolean(),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const ordered =
      coverage.evaluatedFiles <= coverage.selectedFiles &&
      coverage.selectedFiles <= coverage.eligibleFiles &&
      coverage.evaluatedUnits <= coverage.selectedUnits &&
      coverage.selectedUnits <= coverage.eligibleUnits;
    if (!ordered) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'coverage requires evaluated <= selected <= eligible' });
    }
  });

export const securityScopeSchema = z
  .object({
    mode: z.enum(['scan', 'diff']),
    roots: z
      .array(z.union([z.literal('.'), securityRelativePathSchema]))
      .min(1)
      .max(SECURITY_CONTRACT_LIMITS.roots),
    unitId: metadataTextSchema.nullable(),
    baseSha: gitShaSchema.nullable(),
    headSha: gitShaSchema.nullable(),
    inputId: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  })
  .strict();

export const securityProviderMetadataSchema = z
  .object({
    id: llmProviderIdSchema,
    agentVersion: metadataTextSchema.nullable(),
    requestedModel: metadataTextSchema.nullable(),
    resolvedModel: metadataTextSchema.nullable(),
  })
  .strict();

export const securityVersionsSchema = z
  .object({
    selector: versionSchema,
    prompt: versionSchema,
    validator: versionSchema,
    outboundFilter: versionSchema,
    severity: versionSchema,
  })
  .strict();

export const securityUsageSchema = z
  .object({
    calls: countSchema,
    promptBytes: countSchema,
    outputBytes: countSchema,
    durationMs: countSchema,
    inputTokens: countSchema.nullable(),
    outputTokens: countSchema.nullable(),
  })
  .strict();

export const securityFingerprintsSchema = z
  .object({
    policy: sha256Schema.nullable(),
    input: sha256Schema.nullable(),
    packets: sha256Schema.nullable(),
  })
  .strict();

export const securityReasonsSchema = z.array(securityReasonCodeSchema).max(SECURITY_CONTRACT_LIMITS.reasonCodes);

function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export const securityAssessmentSchema = z
  .object({
    schemaVersion: z.literal(SECURITY_ASSESSMENT_SCHEMA_VERSION),
    analysisContractVersion: z.literal(SECURITY_ANALYSIS_CONTRACT_VERSION),
    status: securityStatusSchema,
    reasons: securityReasonsSchema,
    scope: securityScopeSchema,
    coverage: securityCoverageSchema,
    findings: z.array(securityFindingSchema).max(SECURITY_CONTRACT_LIMITS.findingsPerAssessment),
    provider: securityProviderMetadataSchema.nullable(),
    versions: securityVersionsSchema,
    usage: securityUsageSchema,
    fingerprints: securityFingerprintsSchema,
    limitations: narrativeListSchema,
  })
  .strict()
  .superRefine((assessment, ctx) => {
    const issue = (message: string, path: string[] = []) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const { coverage, findings, status, usage } = assessment;
    const fullyEvaluated =
      coverage.evaluatedUnits === coverage.eligibleUnits && totalCount(coverage.incompleteByReason) === 0;

    if (status === 'completed' && !fullyEvaluated) {
      issue('completed assessment must not leave unevaluated or incomplete units', ['coverage']);
    }
    if (status === 'partial' && (coverage.evaluatedUnits === 0 || fullyEvaluated)) {
      issue('partial assessment requires evaluated units and remaining incomplete scope', ['coverage']);
    }
    if (status === 'failed' && coverage.evaluatedUnits !== 0) {
      issue('failed assessment must not report evaluated units', ['coverage']);
    }
    if (status !== 'partial' && status !== 'completed' && findings.length > 0) {
      issue(`${status} assessment must not contain findings`, ['findings']);
    }
    if ((status === 'disabled' || status === 'blocked' || status === 'unavailable') && usage.calls !== 0) {
      issue(`${status} assessment must not record provider calls`, ['usage', 'calls']);
    }
    if (status !== 'disabled' && status !== 'completed' && assessment.reasons.length === 0) {
      issue(`${status} assessment requires at least one reason code`, ['reasons']);
    }
    if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
      issue('findingId values must be unique', ['findings']);
    }
    findings.forEach((finding, index) => {
      if (assessment.scope.mode === 'scan' && finding.relevance !== undefined) {
        issue('scan findings must not declare change relevance', ['findings', String(index), 'relevance']);
      }
      if (assessment.scope.mode === 'diff' && finding.relevance === undefined) {
        issue('diff findings require change relevance', ['findings', String(index), 'relevance']);
      }
    });
  });

export type SecurityCategory = z.infer<typeof securityCategorySchema>;
export type SecurityRevision = z.infer<typeof securityRevisionSchema>;
export type SecuritySeverity = z.infer<typeof securitySeveritySchema>;
export type SecurityConfidence = z.infer<typeof securityConfidenceSchema>;
export type SecurityStatus = z.infer<typeof securityStatusSchema>;
export type SecurityLocation = z.infer<typeof securityLocationSchema>;
export type SecurityEvidenceRef = z.infer<typeof securityEvidenceRefSchema>;
export type SecurityFinding = z.infer<typeof securityFindingSchema>;
export type SecurityCoverage = z.infer<typeof securityCoverageSchema>;
export type SecurityScopeMetadata = z.infer<typeof securityScopeSchema>;
export type SecurityProviderMetadata = z.infer<typeof securityProviderMetadataSchema>;
export type SecurityVersions = z.infer<typeof securityVersionsSchema>;
export type SecurityUsage = z.infer<typeof securityUsageSchema>;
export type SecurityFingerprints = z.infer<typeof securityFingerprintsSchema>;
export type SecurityAssessment = z.infer<typeof securityAssessmentSchema>;
