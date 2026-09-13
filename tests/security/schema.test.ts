import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../../src/intake/snapshot.js';
import { runDiagnosis } from '../../src/pipeline/diagnose.js';
import { analysisResultSchema, securityDryRunSchema } from '../../src/schema/analysis-result.v1.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  BASELINE_SCHEMA_VERSION,
  DIFF_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
} from '../../src/schema/report.v1.js';
import {
  securityAssessmentSchema,
  securityFindingSchema,
  securityLocationSchema,
  type SecurityAssessment,
  type SecurityFinding,
} from '../../src/schema/security-assessment.v1.js';

const SHA = 'a'.repeat(40);

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    findingId: `security-finding:${'b'.repeat(64)}`,
    status: 'candidate',
    category: 'authorization',
    cweIds: ['CWE-862'],
    severity: 'high',
    severityRationale: 'Sensitive data access without authentication prerequisites.',
    confidence: 'medium',
    confidenceRationale: 'The handler and data access are both in the sent snippet.',
    title: 'Order lookup does not check ownership',
    primaryLocation: { path: 'src/orders.ts', revision: 'current', startLine: 4, endLine: 6 },
    evidenceRefs: [
      { path: 'src/orders.ts', revision: 'current', startLine: 1, endLine: 10, snippetId: 'snippet:1', role: 'sink' },
    ],
    preconditions: ['The route is reachable by any authenticated user.'],
    attackPath: 'Request another user order ID.',
    impact: 'Cross-account order disclosure.',
    remediation: 'Compare the order owner with the session user.',
    verification: 'Add a test that requests another user order and expects 404.',
    limitations: [],
    ...overrides,
  };
}

function assessment(overrides: Partial<SecurityAssessment> = {}): SecurityAssessment {
  return {
    schemaVersion: 1,
    analysisContractVersion: 1,
    status: 'completed',
    reasons: [],
    scope: { mode: 'scan', roots: ['.'], unitId: null, baseSha: null, headSha: SHA, inputId: '0123456789abcdef' },
    coverage: {
      eligibleFiles: 1,
      selectedFiles: 1,
      evaluatedFiles: 1,
      eligibleUnits: 2,
      selectedUnits: 2,
      evaluatedUnits: 2,
      excludedByReason: {},
      incompleteByReason: {},
      intakeTruncated: false,
    },
    findings: [finding()],
    provider: { id: 'codex', agentVersion: null, requestedModel: null, resolvedModel: null },
    versions: { selector: '1.0.0', prompt: '1.0.0', validator: '1.0.0', outboundFilter: '1.0.0', severity: '1.0.0' },
    usage: { calls: 1, promptBytes: 1_000, outputBytes: 500, durationMs: 20, inputTokens: null, outputTokens: null },
    fingerprints: { policy: 'c'.repeat(64), input: 'd'.repeat(64), packets: 'e'.repeat(64) },
    limitations: [],
    ...overrides,
  };
}

describe('security location contract', () => {
  it('rejects a location outside the repository', () => {
    for (const unsafePath of ['../outside.ts', '/etc/passwd', 'C:/repo/a.ts', 'src\\a.ts', 'src/./a.ts', 'src//a.ts']) {
      expect(securityLocationSchema.safeParse({
        path: unsafePath, revision: 'current', startLine: 1, endLine: 2,
      }).success).toBe(false);
    }
    expect(securityLocationSchema.safeParse({
      path: 'src/a.ts', revision: 'base', startLine: 1, endLine: 2,
    }).success).toBe(true);
  });

  it('rejects reversed and non-positive line ranges', () => {
    expect(securityLocationSchema.safeParse({ path: 'a.ts', revision: 'current', startLine: 3, endLine: 2 }).success)
      .toBe(false);
    expect(securityLocationSchema.safeParse({ path: 'a.ts', revision: 'current', startLine: 0, endLine: 2 }).success)
      .toBe(false);
  });
});

describe('security finding contract', () => {
  it('requires the primary location to lie within an evidence reference', () => {
    expect(securityFindingSchema.safeParse(finding()).success).toBe(true);
    expect(securityFindingSchema.safeParse(finding({
      primaryLocation: { path: 'src/orders.ts', revision: 'current', startLine: 9, endLine: 12 },
    })).success).toBe(false);
    expect(securityFindingSchema.safeParse(finding({
      primaryLocation: { path: 'src/orders.ts', revision: 'base', startLine: 4, endLine: 6 },
    })).success).toBe(false);
  });

  it('rejects unknown fields, unknown categories, model-owned status, and malformed CWE IDs', () => {
    expect(securityFindingSchema.safeParse({ ...finding(), cvss: 9.8 }).success).toBe(false);
    expect(securityFindingSchema.safeParse({ ...finding(), category: 'misc' }).success).toBe(false);
    expect(securityFindingSchema.safeParse({ ...finding(), status: 'confirmed' }).success).toBe(false);
    expect(securityFindingSchema.safeParse(finding({ cweIds: ['CWE-0'] })).success).toBe(false);
    expect(securityFindingSchema.safeParse(finding({ cweIds: ['CWE-89', 'CWE-89'] })).success).toBe(false);
  });

  it('bounds narrative size and evidence reference counts', () => {
    expect(securityFindingSchema.safeParse(finding({ title: 'x'.repeat(201) })).success).toBe(false);
    expect(securityFindingSchema.safeParse(finding({ impact: 'x'.repeat(4_001) })).success).toBe(false);
    expect(securityFindingSchema.safeParse(finding({ evidenceRefs: [] })).success).toBe(false);
  });
});

describe('security assessment contract', () => {
  it('accepts a completed assessment with evaluated scope', () => {
    expect(securityAssessmentSchema.safeParse(assessment()).success).toBe(true);
  });

  it('rejects a completed assessment that leaves units unevaluated', () => {
    const coverage = assessment().coverage;
    expect(securityAssessmentSchema.safeParse(assessment({
      coverage: { ...coverage, evaluatedUnits: 1 },
    })).success).toBe(false);
    expect(securityAssessmentSchema.safeParse(assessment({
      coverage: { ...coverage, incompleteByReason: { 'budget-exhausted': 1 } },
    })).success).toBe(false);
  });

  it('accepts an empty applicable scope as completed', () => {
    expect(securityAssessmentSchema.safeParse(assessment({
      reasons: ['no-applicable-changes'],
      scope: { mode: 'diff', roots: ['.'], unitId: null, baseSha: SHA, headSha: SHA, inputId: null },
      coverage: {
        eligibleFiles: 0, selectedFiles: 0, evaluatedFiles: 0,
        eligibleUnits: 0, selectedUnits: 0, evaluatedUnits: 0,
        excludedByReason: {}, incompleteByReason: {}, intakeTruncated: false,
      },
      findings: [],
      provider: null,
      usage: { calls: 0, promptBytes: 0, outputBytes: 0, durationMs: 0, inputTokens: null, outputTokens: null },
    })).success).toBe(true);
  });

  it('distinguishes partial from failed coverage', () => {
    const coverage = { ...assessment().coverage, evaluatedUnits: 1, incompleteByReason: { timeout: 1 } };
    expect(securityAssessmentSchema.safeParse(assessment({ status: 'partial', reasons: ['timeout'], coverage }))
      .success).toBe(true);
    expect(securityAssessmentSchema.safeParse(assessment({ status: 'partial', reasons: [] , coverage }))
      .success).toBe(false);
    expect(securityAssessmentSchema.safeParse(assessment({ status: 'failed', reasons: ['timeout'], coverage }))
      .success).toBe(false);
  });

  it('forbids findings and provider calls before execution is allowed', () => {
    const idleUsage = { calls: 0, promptBytes: 0, outputBytes: 0, durationMs: 0, inputTokens: null, outputTokens: null };
    const coverage = { ...assessment().coverage, evaluatedFiles: 0, evaluatedUnits: 0 };
    const blocked = { status: 'blocked' as const, reasons: ['operator-consent-required'], coverage, provider: null };
    expect(securityAssessmentSchema.safeParse(assessment({ ...blocked, findings: [], usage: idleUsage })).success)
      .toBe(true);
    expect(securityAssessmentSchema.safeParse(assessment({ ...blocked, findings: [] })).success).toBe(false);
    expect(securityAssessmentSchema.safeParse(assessment({ ...blocked, usage: idleUsage })).success).toBe(false);
    expect(securityAssessmentSchema.safeParse(assessment({ ...blocked, reasons: [], findings: [], usage: idleUsage }))
      .success).toBe(false);
  });

  it('ties change relevance to the analysis mode and keeps finding IDs unique', () => {
    expect(securityAssessmentSchema.safeParse(assessment({ findings: [finding({ relevance: 'direct-change' })] }))
      .success).toBe(false);
    expect(securityAssessmentSchema.safeParse(assessment({ findings: [finding(), finding()] })).success).toBe(false);
  });
});

describe('analysis result envelope', () => {
  it('wraps an unchanged core report and requires matching modes', async () => {
    const snapshot = await createRepositorySnapshot(path.resolve('tests/fixtures/stable-cart'));
    const core = await runDiagnosis(snapshot, { skipCalibrationResolution: true });
    const envelope = { schemaVersion: 1, kind: 'r3-doctor-analysis', mode: 'scan', core, addons: { security: assessment() } };

    expect(analysisResultSchema.parse(envelope).core).toEqual(core);
    expect(analysisResultSchema.safeParse({ ...envelope, mode: 'diff' }).success).toBe(false);
    expect(analysisResultSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it('keeps dry-run summaries free of batches unless planned', () => {
    const base = {
      schemaVersion: 1,
      kind: 'r3-doctor-security-dry-run',
      reasons: [],
      scope: assessment().scope,
      coverage: assessment().coverage,
      batches: [{ batchId: 'batch:1', unitCount: 2, fileCount: 1, promptBytes: 1_024 }],
      fingerprints: { policy: null, input: null },
      limitations: [],
    };
    expect(securityDryRunSchema.safeParse({ ...base, status: 'planned' }).success).toBe(true);
    expect(securityDryRunSchema.safeParse({ ...base, status: 'blocked', reasons: ['operator-consent-required'] })
      .success).toBe(false);
    expect(securityDryRunSchema.safeParse({ ...base, status: 'planned', prompt: 'source' }).success).toBe(false);
  });

  it('leaves core schema versions unchanged', () => {
    expect([REPORT_SCHEMA_VERSION, BASELINE_SCHEMA_VERSION, DIFF_SCHEMA_VERSION, ASSESSMENT_CONTRACT_VERSION])
      .toEqual([2, 4, 3, 4]);
  });
});
