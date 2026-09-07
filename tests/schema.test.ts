import { describe, expect, it } from 'vitest';

import {
  ASSESSMENT_CONTRACT_VERSION,
  BASELINE_SCHEMA_VERSION,
  DIFF_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  baselineEntrySchema,
  diagnosisReportSchema,
  diffReportSchema,
  semanticFindingSchema,
} from '../src/schema/report.v1.js';
import type { DiagnosisReport } from '../src/schema/report.v1.js';
import { redactionPolicyFingerprint } from '../src/shared/redaction.js';
import { configSchema } from '../src/shared/config.js';
import { validateSemanticFindings } from '../src/semantic/provider.js';

function sampleEvidence(overrides: Partial<DiagnosisReport['evidence'][number]> = {}) {
  return {
    evidenceId: 'evidence:large-file:src/a.ts',
    signalId: 'large-file' as const,
    axisId: 'structural-fragility' as const,
    path: 'src/a.ts',
    strength: 50,
    rationale: 'provisional:severity=medium',
    pathRole: 'product' as const,
    relatedPaths: ['src/a.ts'],
    severity: 'medium' as const,
    message: 'large file',
    source: 'deterministic' as const,
    ...overrides,
  };
}

function sampleAxis(overrides: Partial<DiagnosisReport['axes'][number]> = {}) {
  return {
    axisId: 'structural-fragility' as const,
    name: 'Structural Fragility',
    score: 25,
    contributionPoints: 25,
    scoreBreakdown: { peak: 25, breadth: 0, diversity: 0 },
    confidence: 0.8,
    unevaluated: false,
    ...overrides,
  };
}

function minimalRepository(overrides: Partial<DiagnosisReport['repository']> = {}) {
  return {
    regressionRiskScore: 10,
    confidence: 1,
    disclaimer: 'test',
    scoreBreakdown: { axisBase: 10, criticalClusterUplift: 0 },
    confidenceBreakdown: {
      signalCoverage: 1,
      semanticAnalysis: 0,
      gitHistory: 1,
      inputCompleteness: 1,
    },
    calibration: { status: 'uncalibrated' as const },
    ...overrides,
  };
}

function minimalReport(inputId = 'report-id', generatedAt = '2026-01-01T00:00:00.000Z'): DiagnosisReport {
  return {
    metadata: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
      generatedAt,
      inputId,
      repositoryPath: '/tmp/repository',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
    },
    repository: minimalRepository(),
    axes: [sampleAxis()],
    clusters: [],
    evidence: [sampleEvidence()],
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

function v3Report(): Record<string, unknown> {
  return {
    metadata: {
      schemaVersion: 1,
      assessmentContractVersion: 3,
      generatedAt: '2026-01-01T00:00:00.000Z',
      inputId: 'v3-report',
      repositoryPath: '/tmp/repository',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
    },
    repository: {
      regressionRiskScore: 10,
      confidence: 1,
      disclaimer: 'test',
    },
    axes: [{
      axisId: 'structural-fragility',
      name: 'Structural Fragility',
      score: 25,
      contribution: 0.5,
      confidence: 0.8,
      unevaluated: false,
    }],
    clusters: [],
    evidence: [{
      evidenceId: 'evidence:large-file:src/a.ts',
      signalId: 'large-file',
      axisId: 'structural-fragility',
      path: 'src/a.ts',
      severity: 'medium',
      message: 'large file',
      source: 'deterministic',
    }],
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

function comparison(compatible: boolean): Record<string, unknown> {
  return {
    compatible,
    changedFiles: [],
    blastRadius: [],
    newSignals: [],
    worsenedSignals: [],
    improvedSignals: [],
  };
}

describe('assessment contract v4', () => {
  it('rejects legacy v3 reports and requires actionable v4 fields', () => {
    const v4Report = minimalReport();

    expect(diagnosisReportSchema.safeParse(v3Report()).success).toBe(false);
    expect(diagnosisReportSchema.safeParse(v4Report).success).toBe(true);
    expect(v4Report.repository.calibration.status).toBe('uncalibrated');
    expect(v4Report.axes[0]).toMatchObject({
      contributionPoints: expect.any(Number),
      scoreBreakdown: { peak: expect.any(Number), breadth: expect.any(Number), diversity: expect.any(Number) },
    });
    expect(v4Report.evidence[0]).toMatchObject({
      strength: expect.any(Number),
      rationale: expect.any(String),
      pathRole: 'product',
      relatedPaths: expect.any(Array),
    });
  });

  it('rejects evidence when severity is not derived from strength', () => {
    const report = minimalReport();
    const invalidEvidence = { ...sampleEvidence(), strength: 80, severity: 'low' as const };
    expect(diagnosisReportSchema.safeParse({ ...report, evidence: [invalidEvidence] }).success).toBe(false);
  });
});

describe('schema reference integrity', () => {
  it('requires every compatible Diff v3 baseline-derived field', () => {
    const result = diffReportSchema.safeParse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current: minimalReport('current'),
      comparison: comparison(true),
    });

    expect(result.success).toBe(false);
  });

  it('forbids baseline-derived fields on an incompatible Diff v3 report', () => {
    const base = minimalReport('base');
    const result = diffReportSchema.safeParse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current: minimalReport('current'),
      base,
      comparison: {
        ...comparison(false),
        riskDelta: 0,
        baselineId: base.metadata.inputId,
      },
    });

    expect(result.success).toBe(false);
  });

  it('requires compatible Diff v3 baseline identity and score arithmetic to agree', () => {
    const base = minimalReport('base');
    const current = {
      ...minimalReport('current'),
      repository: { ...minimalReport('current').repository, regressionRiskScore: 25 },
    };
    const value = {
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      base,
      comparison: {
        ...comparison(true),
        baselineId: base.metadata.inputId,
        riskDelta: 15,
      },
    };

    expect(diffReportSchema.safeParse(value).success).toBe(true);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: { ...value.comparison, baselineId: 'wrong' },
    }).success).toBe(false);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: { ...value.comparison, riskDelta: 14 },
    }).success).toBe(false);
  });

  it('requires compatible signal changes to be disjoint and exactly match report evidence', () => {
    const baseEvidence = sampleEvidence({ severity: 'low', strength: 25, rationale: 'provisional:severity=low', message: 'base severity' });
    const currentEvidence = { ...baseEvidence, severity: 'high' as const, strength: 75, rationale: 'provisional:severity=high', message: 'current severity' };
    const base = { ...minimalReport('base'), evidence: [baseEvidence] };
    const current = { ...minimalReport('current'), evidence: [currentEvidence] };
    const worsened = {
      evidenceId: currentEvidence.evidenceId,
      signalId: currentEvidence.signalId,
      path: currentEvidence.path,
      previousSeverity: baseEvidence.severity,
      currentSeverity: currentEvidence.severity,
      message: currentEvidence.message,
    };
    const value = {
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      base,
      comparison: {
        ...comparison(true),
        baselineId: base.metadata.inputId,
        riskDelta: 0,
        worsenedSignals: [worsened],
      },
    };

    expect(diffReportSchema.safeParse(value).success).toBe(true);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: { ...value.comparison, newSignals: [worsened] },
    }).success).toBe(false);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: {
        ...value.comparison,
        worsenedSignals: [],
        newSignals: [{ ...worsened, evidenceId: 'evidence:large-file:src/phantom.ts' }],
      },
    }).success).toBe(false);
  });

  it('requires an incompatibility reason and empty signal changes', () => {
    const value = {
      schemaVersion: DIFF_SCHEMA_VERSION,
      current: minimalReport('current'),
      comparison: {
        ...comparison(false),
        reason: 'analysis context mismatch',
      },
    };
    const signal = {
      evidenceId: 'evidence:large-file:src/a.ts',
      signalId: 'large-file',
      currentSeverity: 'medium',
      message: 'unexpected change',
    };

    expect(diffReportSchema.safeParse(value).success).toBe(true);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: { ...value.comparison, reason: undefined },
    }).success).toBe(false);
    expect(diffReportSchema.safeParse({
      ...value,
      comparison: { ...value.comparison, newSignals: [signal] },
    }).success).toBe(false);
  });

  it('enforces baseline metadata and report consistency', () => {
    const fingerprint = redactionPolicyFingerprint([]);
    const report = {
      ...minimalReport(),
      metadata: {
        ...minimalReport().metadata,
        redactionPolicyFingerprint: fingerprint,
      },
    } as DiagnosisReport;
    const entry = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      kind: 'r3-doctor/baseline',
      inputId: report.metadata.inputId,
      generatedAt: report.metadata.generatedAt,
      assessmentContractVersion: report.metadata.assessmentContractVersion,
      sourceCommitSha: 'a'.repeat(40),
      redactionPolicyFingerprint: fingerprint,
      analysisContextFingerprint: 'b'.repeat(64),
      report,
    };

    expect(baselineEntrySchema.safeParse(entry).success).toBe(true);
    expect(baselineEntrySchema.safeParse({ ...entry, inputId: 'other' }).success).toBe(false);
    expect(baselineEntrySchema.safeParse({ ...entry, generatedAt: '2026-01-02T00:00:00.000Z' }).success).toBe(false);
    expect(baselineEntrySchema.safeParse({ ...entry, redactionPolicyFingerprint: 'c'.repeat(64) }).success).toBe(false);
  });

  it('rejects v3 baseline entries against the current assessment contract', () => {
    const fingerprint = redactionPolicyFingerprint([]);
    const v3BaselineReport = v3Report();
    const entry = {
      schemaVersion: 3,
      kind: 'r3-doctor/baseline',
      inputId: 'v3-report',
      generatedAt: '2026-01-01T00:00:00.000Z',
      assessmentContractVersion: 3,
      sourceCommitSha: 'a'.repeat(40),
      redactionPolicyFingerprint: fingerprint,
      analysisContextFingerprint: 'b'.repeat(64),
      report: v3BaselineReport,
    };

    expect(baselineEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects duplicate entity IDs within the same report collection', () => {
    const report = minimalReport();
    const evidence = sampleEvidence();

    expect(diagnosisReportSchema.safeParse({ ...report, evidence: [evidence, evidence] }).success).toBe(false);
  });

  it('rejects semantic findings without path or related evidence', () => {
    const result = semanticFindingSchema.safeParse({
      findingId: 'finding:1',
      axisId: 'semantic-ambiguity',
      summary: 'ambiguous',
      relatedEvidenceIds: [],
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects dangling evidence references in report', () => {
    const result = diagnosisReportSchema.safeParse({
      metadata: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'x',
        repositoryPath: '/tmp',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: minimalRepository(),
      axes: [sampleAxis()],
      clusters: [{
        clusterId: 'cluster:structural-fragility:dependency-cycle:1',
        title: 't',
        score: 1,
        confidence: 1,
        axisId: 'structural-fragility',
        mechanismId: 'dependency-cycle',
        paths: [],
        failureMechanism: 'm',
        triggerChanges: [],
        evidenceIds: ['evidence:missing'],
      }],
      evidence: [],
      semanticFindings: [],
      interventions: [],
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('validates semantic provider output and rejects dangling evidence', () => {
    const snapshot = {
      repositoryPath: '/tmp/repo',
      files: [],
      inputId: 'x',
      gitAvailable: false,
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as never;

    expect(() =>
      validateSemanticFindings(
        [{ axisId: 'semantic-ambiguity', summary: 'x', relatedEvidenceIds: ['evidence:missing'], confidence: 0.5 }],
        snapshot,
        [],
      ),
    ).toThrow(/dangling evidence reference/);
  });

  it('REG-2026-002 grounds semantic finding paths in exact snapshot files', () => {
    const snapshot = {
      repositoryPath: '/tmp/repo',
      files: [{ relativePath: 'src/a.ts' }],
      inputId: 'x',
      gitAvailable: false,
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as never;
    const finding = (findingPath: string) => [{
      axisId: 'semantic-ambiguity',
      summary: 'x',
      relatedEvidenceIds: [],
      confidence: 0.5,
      path: findingPath,
    }];

    expect(validateSemanticFindings(finding('src\\a.ts'), snapshot, [])[0]?.path).toBe('src/a.ts');
    for (const invalidPath of ['/tmp/repo/src/a.ts', '../repo/src/a.ts', '/tmp/repo-sibling/a.ts', 'src/missing.ts']) {
      expect(() => validateSemanticFindings(finding(invalidPath), snapshot, [])).toThrow(/semantic finding path/);
    }
  });

  it('normalizes openai and anthropic provider aliases in config', () => {
    expect(
      configSchema.parse({ schemaVersion: 1, llm: { enabled: true, provider: 'openai' } }).llm.provider,
    ).toBe('codex');
    expect(
      configSchema.parse({ schemaVersion: 1, llm: { enabled: true, provider: 'anthropic' } }).llm.provider,
    ).toBe('claude');
  });

  it('filters non-semantic-ambiguity findings during validation', () => {
    const snapshot = {
      repositoryPath: '/tmp/repo',
      files: [{ relativePath: 'src/a.ts' }],
      inputId: 'x',
      gitAvailable: false,
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as never;

    const findings = validateSemanticFindings(
      [
        { axisId: 'structural-fragility', summary: 'ignored', relatedEvidenceIds: [], confidence: 0.5, path: 'src/a.ts' },
        { axisId: 'semantic-ambiguity', summary: 'kept', relatedEvidenceIds: [], confidence: 0.6, path: 'src/a.ts' },
      ],
      snapshot,
      [],
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.axisId).toBe('semantic-ambiguity');
  });

  it('preserves impactScope on validated semantic findings', () => {
    const snapshot = {
      repositoryPath: '/tmp/repo',
      files: [{ relativePath: 'src/a.ts' }],
      inputId: 'x',
      gitAvailable: false,
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as never;

    const findings = validateSemanticFindings(
      [{
        axisId: 'semantic-ambiguity',
        summary: 'repository-wide ambiguity',
        relatedEvidenceIds: [],
        confidence: 0.8,
        path: 'src/a.ts',
        impactScope: 'repository',
      }],
      snapshot,
      [],
    );

    expect(findings[0]?.impactScope).toBe('repository');
  });
});
