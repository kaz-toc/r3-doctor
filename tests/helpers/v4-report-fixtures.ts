import type { DiagnosisReport } from '../../src/schema/report.v1.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  REPORT_SCHEMA_VERSION,
  provisionalEvidenceDetails,
} from '../../src/schema/report.v1.js';

export function minimalRepository(
  overrides: Partial<DiagnosisReport['repository']> = {},
): DiagnosisReport['repository'] {
  return {
    regressionRiskScore: 1,
    confidence: 1,
    disclaimer: 'test',
    scoreBreakdown: { axisBase: 1, criticalClusterUplift: 0 },
    confidenceBreakdown: {
      signalCoverage: 1,
      semanticAnalysis: 0,
      gitHistory: 1,
      inputCompleteness: 1,
    },
    calibration: { status: 'uncalibrated' },
    ...overrides,
  };
}

export function minimalReportMetadata(
  overrides: Partial<DiagnosisReport['metadata']> = {},
): DiagnosisReport['metadata'] {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputId: 'input',
    repositoryPath: '/tmp/repository',
    analyzers: [],
    truncated: false,
    unevaluatedAreas: [],
    ...overrides,
  };
}

export function sampleEvidence(
  overrides: Partial<DiagnosisReport['evidence'][number]> = {},
): DiagnosisReport['evidence'][number] {
  const severity = overrides.severity ?? 'medium';
  const path = overrides.path ?? 'src/a.ts';
  return {
    evidenceId: 'evidence:large-file:src/a.ts',
    signalId: 'large-file',
    axisId: 'structural-fragility',
    path,
    severity,
    message: 'large file',
    source: 'deterministic',
    ...provisionalEvidenceDetails(severity, path),
    ...overrides,
  };
}

export function minimalV4Report(overrides: Partial<DiagnosisReport> = {}): DiagnosisReport {
  const {
    metadata,
    repository,
    axes,
    clusters,
    evidence,
    semanticFindings,
    interventions,
    capabilities,
  } = overrides;
  return {
    metadata: minimalReportMetadata(metadata),
    repository: minimalRepository(repository),
    axes: axes ?? [],
    clusters: clusters ?? [],
    evidence: evidence ?? [],
    semanticFindings: semanticFindings ?? [],
    interventions: interventions ?? [],
    capabilities: capabilities ?? [],
  };
}
