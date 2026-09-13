import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  SECURITY_CONTRACT_LIMITS,
  securityCategorySchema,
  securityConfidenceSchema,
  securityEvidenceRoleSchema,
  securityFindingSchema,
  securityRelativePathSchema,
  securityRevisionSchema,
  type SecurityEvidenceRef,
  type SecurityFinding,
} from '../../schema/security-assessment.v1.js';

import {
  capSecurityConfidence,
  classifySeverity,
  higherSeverity,
  securityAttackPrerequisiteSchema,
  securityImpactClassSchema,
} from './severity.js';
import type { SecurityBatch, SecurityBatchResult, SecuritySnippet, SecurityUnit } from './types.js';

export { securityAttackPrerequisiteSchema, securityImpactClassSchema } from './severity.js';

export const SECURITY_RESPONSE_VALIDATOR_VERSION = '1.0.0';
export const SECURITY_RESPONSE_MAX_BYTES = 256 * 1024;
export const SECURITY_FINDINGS_PER_BATCH = 64;

/** Envelope-level failure: the whole batch is failed. Messages never include model text. */
export class SecurityResponseError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'SecurityResponseError';
    this.reason = reason;
  }
}

const unitStatusSchema = z.enum(['evaluated', 'insufficient-context']);

const rawResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    batchId: z.string().min(1).max(64),
    units: z.array(z.object({ unitId: z.string().min(1).max(64), status: unitStatusSchema }).strict()).max(64),
    findings: z.array(z.unknown()).max(SECURITY_FINDINGS_PER_BATCH),
  })
  .strict();

export type SecurityRawResponse = z.infer<typeof rawResponseSchema>;

const narrativeSchema = z.string().min(1).max(SECURITY_CONTRACT_LIMITS.narrativeChars);
const narrativeListSchema = z.array(narrativeSchema).max(SECURITY_CONTRACT_LIMITS.narrativeItems);
const rawLocationSchema = z
  .object({
    path: securityRelativePathSchema,
    revision: securityRevisionSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict();

/** Model-owned fields only. findingId, status, and severity are host-owned and rejected when supplied. */
const rawFindingSchema = z
  .object({
    unitId: z.string().min(1).max(64),
    category: securityCategorySchema,
    cweIds: z.array(z.string().regex(/^CWE-[1-9][0-9]*$/u)).max(SECURITY_CONTRACT_LIMITS.cweIdsPerFinding),
    impactClass: securityImpactClassSchema,
    attackPrerequisites: securityAttackPrerequisiteSchema,
    severityRationale: narrativeSchema,
    confidence: securityConfidenceSchema,
    confidenceRationale: narrativeSchema,
    title: z.string().min(1).max(SECURITY_CONTRACT_LIMITS.titleChars),
    primaryLocation: rawLocationSchema,
    evidenceRefs: z
      .array(rawLocationSchema.extend({ snippetId: z.string().min(1).max(160), role: securityEvidenceRoleSchema }).strict())
      .min(1)
      .max(SECURITY_CONTRACT_LIMITS.evidenceRefsPerFinding),
    preconditions: narrativeListSchema,
    attackPath: narrativeSchema,
    impact: narrativeSchema,
    remediation: narrativeSchema,
    verification: narrativeSchema,
    limitations: narrativeListSchema,
  })
  .strict();

type RawFinding = z.infer<typeof rawFindingSchema>;
type Candidate = { unit: SecurityUnit; finding: RawFinding };
type UnitStatus = z.infer<typeof unitStatusSchema>;

/** Accepts exactly one bounded JSON object. Prose, Markdown fences, and multiple values are rejected. */
export function parseSecurityResponse(text: string): SecurityRawResponse {
  if (Buffer.byteLength(text, 'utf8') > SECURITY_RESPONSE_MAX_BYTES) {
    throw new SecurityResponseError('response-too-large', `security response exceeds ${SECURITY_RESPONSE_MAX_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new SecurityResponseError('invalid-json', 'security response is not a single JSON value');
  }
  const parsed = rawResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new SecurityResponseError('invalid-envelope', 'security response envelope does not match the contract');
  }
  return parsed.data;
}

function referencesSentCode(finding: RawFinding, snippets: ReadonlyMap<string, SecuritySnippet>): boolean {
  const refsValid = finding.evidenceRefs.every((ref) => {
    const snippet = snippets.get(ref.snippetId);
    return snippet !== undefined
      && snippet.path === ref.path
      && snippet.revision === ref.revision
      && snippet.startLine <= ref.startLine
      && ref.startLine <= ref.endLine
      && ref.endLine <= snippet.endLine;
  });
  const primary = finding.primaryLocation;
  return refsValid && primary.startLine <= primary.endLine && finding.evidenceRefs.some((ref) =>
    ref.path === primary.path && ref.revision === primary.revision
    && ref.startLine <= primary.startLine && primary.endLine <= ref.endLine);
}

function findingIdOf(category: string, unit: SecurityUnit): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([category, unit.path, unit.revision, unit.anchor]))
    .digest('hex');
  return `security-finding:${digest}`;
}

function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string, limit: number): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function severityRationale(finding: RawFinding): string {
  const prefix = `Impact class (model-classified): ${finding.impactClass}; attack prerequisites (model-classified): ${finding.attackPrerequisites}. `;
  return `${prefix}${finding.severityRationale}`.slice(0, SECURITY_CONTRACT_LIMITS.narrativeChars);
}

function mergeCandidates(group: readonly Candidate[], status: UnitStatus): SecurityFinding | null {
  const first = group[0];
  if (!first) return null;
  const { unit } = first;
  const severityOf = (candidate: Candidate) => classifySeverity({
    impact: candidate.finding.impactClass,
    prerequisites: candidate.finding.attackPrerequisites,
    evidenceRoles: candidate.finding.evidenceRefs.map((ref) => ref.role),
  });
  const representative = group.reduce((best, candidate) =>
    (higherSeverity(severityOf(best), severityOf(candidate)) === severityOf(best) ? best : candidate));
  const report = representative.finding;
  const conflicting = new Set(group.map((candidate) =>
    [severityOf(candidate), candidate.finding.impactClass, candidate.finding.attackPrerequisites, candidate.finding.confidence].join('|'))).size > 1;
  const evidenceRefs: SecurityEvidenceRef[] = uniqueBy(
    [report, ...group.map((candidate) => candidate.finding)].flatMap((finding) => finding.evidenceRefs),
    (ref) => `${ref.snippetId}|${ref.startLine}|${ref.endLine}|${ref.role}`,
    SECURITY_CONTRACT_LIMITS.evidenceRefsPerFinding,
  );
  const mergeNote = group.length > 1
    ? [`Merged ${group.length} reports for the same location${conflicting ? ' with differing impact, prerequisites, or confidence' : ''}.`]
    : [];

  const finding: SecurityFinding = {
    findingId: findingIdOf(report.category, unit),
    status: 'candidate',
    category: report.category,
    cweIds: uniqueBy(group.flatMap((candidate) => candidate.finding.cweIds), (id) => id, SECURITY_CONTRACT_LIMITS.cweIdsPerFinding),
    severity: group.map(severityOf).reduce(higherSeverity),
    severityRationale: severityRationale(report),
    confidence: capSecurityConfidence({
      proposed: report.confidence,
      prerequisites: group.some((candidate) => candidate.finding.attackPrerequisites === 'unknown') ? 'unknown' : report.attackPrerequisites,
      unitStatus: status,
      unitLimitations: unit.limitations,
      conflicting,
    }),
    confidenceRationale: report.confidenceRationale,
    title: report.title,
    primaryLocation: report.primaryLocation,
    evidenceRefs,
    preconditions: uniqueBy(group.flatMap((candidate) => candidate.finding.preconditions), (value) => value, SECURITY_CONTRACT_LIMITS.narrativeItems),
    attackPath: report.attackPath,
    impact: report.impact,
    remediation: report.remediation,
    verification: report.verification,
    limitations: uniqueBy(
      [...mergeNote, ...group.flatMap((candidate) => candidate.finding.limitations)],
      (value) => value,
      SECURITY_CONTRACT_LIMITS.narrativeItems,
    ),
    ...(unit.relevance ? { relevance: unit.relevance } : {}),
  };
  const checked = securityFindingSchema.safeParse(finding);
  return checked.success ? checked.data : null;
}

/**
 * Validates a parsed response against the batch that was actually sent. Envelope mismatches throw and fail
 * the batch. An invalid finding is dropped and leaves its unit incomplete; a finding that cannot be attributed
 * to a sent unit leaves the whole batch incomplete. Units missing from the response are never evaluated.
 */
export function validateSecurityResponse(raw: SecurityRawResponse, batch: SecurityBatch): SecurityBatchResult {
  if (raw.batchId !== batch.batchId) {
    throw new SecurityResponseError('batch-mismatch', 'security response batch ID does not match the sent batch');
  }
  const units = new Map(batch.units.map((unit) => [unit.unitId, unit]));
  const statuses = new Map<string, UnitStatus>();
  for (const entry of raw.units) {
    if (!units.has(entry.unitId) || statuses.has(entry.unitId)) {
      throw new SecurityResponseError('unit-mismatch', 'security response units do not match the sent batch');
    }
    statuses.set(entry.unitId, entry.status);
  }

  const incomplete = new Map<string, string>();
  for (const unit of batch.units) {
    const status = statuses.get(unit.unitId);
    if (status === undefined) incomplete.set(unit.unitId, 'unit-missing');
    else if (status === 'insufficient-context') incomplete.set(unit.unitId, 'insufficient-context');
  }

  const snippets = new Map(batch.snippets.map((snippet) => [snippet.snippetId, snippet]));
  const groups = new Map<string, Candidate[]>();
  let invalidFindingCount = 0;
  let unattributed = false;
  const markInvalid = (unit: SecurityUnit | undefined) => {
    invalidFindingCount += 1;
    if (!unit) unattributed = true;
    else if (!incomplete.has(unit.unitId)) incomplete.set(unit.unitId, 'invalid-finding');
  };

  for (const value of raw.findings) {
    const unitId = typeof value === 'object' && value !== null && 'unitId' in value ? value.unitId : undefined;
    const unit = typeof unitId === 'string' ? units.get(unitId) : undefined;
    const parsed = rawFindingSchema.safeParse(value);
    if (!unit || !parsed.success || !referencesSentCode(parsed.data, snippets)) {
      markInvalid(unit);
      continue;
    }
    const key = findingIdOf(parsed.data.category, unit);
    groups.set(key, [...(groups.get(key) ?? []), { unit, finding: parsed.data }]);
  }

  const findings: SecurityFinding[] = [];
  for (const group of groups.values()) {
    const unit = group[0]?.unit;
    const merged = mergeCandidates(group, statuses.get(unit?.unitId ?? '') ?? 'evaluated');
    if (merged) findings.push(merged);
    else markInvalid(unit);
  }

  if (unattributed) {
    for (const unit of batch.units) incomplete.set(unit.unitId, 'invalid-finding-unattributed');
  }
  const reasons = unattributed ? ['invalid-finding-unattributed'] : [...new Set(incomplete.values())].sort();
  return {
    batchId: batch.batchId,
    evaluatedUnitIds: batch.units.filter((unit) => !incomplete.has(unit.unitId)).map((unit) => unit.unitId),
    incompleteUnitIds: batch.units.filter((unit) => incomplete.has(unit.unitId)).map((unit) => unit.unitId),
    findings,
    reasons,
    invalidFindingCount,
  };
}
