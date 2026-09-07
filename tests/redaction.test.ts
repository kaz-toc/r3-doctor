import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { redactReport, redactionPolicyFingerprint } from '../src/shared/redaction.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { deriveGateEligible } from '../src/operations/policy.js';
import { diagnosisReportSchema, diffReportSchema } from '../src/schema/report.v1.js';
import type { DiagnosisReport } from '../src/schema/report.v1.js';
import { redactDiffReport } from '../src/shared/redaction.js';

const root = path.dirname(fileURLToPath(import.meta.url));

describe('policy redaction and gate eligibility', () => {
  it('REG-2026-005 always removes the absolute repository path from external reports', async () => {
    const snapshot = await createRepositorySnapshot(path.join(root, 'fixtures', 'stable-cart'));
    const report = await runDiagnosis(snapshot);

    const redacted = redactReport(report, []);

    expect(redacted.metadata.repositoryPath).toBe('[REPOSITORY]');
    expect(JSON.stringify(redacted)).not.toContain(snapshot.repositoryPath);
  });

  it('redacts configured path segments consistently', async () => {
    const snapshot = await createRepositorySnapshot(path.join(root, 'fixtures', 'stable-cart'));
    const report = await runDiagnosis(snapshot);
    const redacted = redactReport(report, ['stable-cart']);
    expect(JSON.stringify(redacted)).not.toContain('stable-cart');
    expect(report.metadata.repositoryPath).toContain('stable-cart');
  });

  it('fingerprints a normalized set of redaction paths', () => {
    expect(redactionPolicyFingerprint(['secret/b', 'secret/a', 'secret/b']))
      .toBe(redactionPolicyFingerprint(['secret/a', 'secret/b']));
    expect(redactionPolicyFingerprint(['secret/a']))
      .not.toBe(redactionPolicyFingerprint(['secret/b']));
  });

  it('applies overlapping redaction paths in the same canonical order used by the fingerprint', async () => {
    const snapshot = await createRepositorySnapshot(path.join(root, 'fixtures', 'stable-cart'));
    const report = await runDiagnosis(snapshot);

    expect(redactReport(report, ['stable', 'stable-cart']))
      .toEqual(redactReport(report, ['stable-cart', 'stable', 'stable-cart']));
  });

  it('preserves entity namespaces and remains idempotent for already-redacted reports', () => {
    const evidenceId = 'evidence:large-file:Repo/evidence/a.ts';
    const report: DiagnosisReport = {
      metadata: {
        schemaVersion: 1,
        assessmentContractVersion: 2,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'input',
        repositoryPath: '/Repo/evidence',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: { regressionRiskScore: 1, confidence: 1, disclaimer: 'test' },
      axes: [],
      clusters: [],
      evidence: [{
        evidenceId,
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'Repo/evidence/a.ts',
        severity: 'medium',
        message: 'Repo evidence path',
        source: 'deterministic',
      }],
      semanticFindings: [],
      interventions: [],
      capabilities: [],
    };

    const once = redactReport(report, ['evidence', 'R']);
    const twice = redactReport(once, ['R', 'evidence']);

    expect(diagnosisReportSchema.safeParse(once).success).toBe(true);
    expect(twice).toEqual(once);
    expect(once.evidence[0]?.evidenceId).toMatch(/^evidence:/);
    expect(once.metadata.redactionPolicyFingerprint).toBe(redactionPolicyFingerprint(['evidence', 'R']));
  });

  it('removes legacy absolute paths from already-redacted reports', () => {
    const redacted = redactReport({
      metadata: {
        schemaVersion: 1 as const,
        assessmentContractVersion: 2 as const,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'input',
        repositoryPath: '/private/legacy/repository',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: { regressionRiskScore: 1, confidence: 1, disclaimer: 'test' },
      axes: [],
      clusters: [],
      evidence: [],
      semanticFindings: [],
      interventions: [],
      capabilities: [],
    }, []);
    const report = {
      ...redacted,
      metadata: {
        ...redacted.metadata,
        repositoryPath: '/private/legacy/repository',
      },
    };

    expect(redactReport(report, []).metadata.repositoryPath).toBe('[REPOSITORY]');
  });

  it('removes legacy absolute paths from an already-redacted diff', () => {
    const current = redactReport({
      metadata: {
        schemaVersion: 1,
        assessmentContractVersion: 2,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'current',
        repositoryPath: '/private/legacy/repository',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: { regressionRiskScore: 1, confidence: 1, disclaimer: 'test' },
      axes: [], clusters: [], evidence: [], semanticFindings: [], interventions: [], capabilities: [],
    }, []);
    const legacyCurrent = {
      ...current,
      metadata: { ...current.metadata, repositoryPath: '/private/legacy/repository' },
    };
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
      current: legacyCurrent,
      comparison: {
        compatible: false,
        reason: 'legacy comparison',
        changedFiles: [], blastRadius: [], newSignals: [], worsenedSignals: [], improvedSignals: [],
      },
    });

    expect(redactDiffReport(diff, []).current.metadata.repositoryPath).toBe('[REPOSITORY]');
  });

  it('keeps raw token-shaped entity IDs distinct from generated pseudonyms', () => {
    const pseudonym = createHash('sha256').update('r3-doctor-redaction-v1\0secret').digest('hex');
    const report = {
      metadata: {
        schemaVersion: 1 as const,
        assessmentContractVersion: 2 as const,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'input',
        repositoryPath: '/repository',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: { regressionRiskScore: 1, confidence: 1, disclaimer: 'test' },
      axes: [],
      clusters: [],
      evidence: [
        {
          evidenceId: 'evidence:large-file:secret',
          signalId: 'large-file' as const,
          axisId: 'structural-fragility' as const,
          path: 'secret',
          severity: 'medium' as const,
          message: 'secret',
          source: 'deterministic' as const,
        },
        {
          evidenceId: `evidence:large-file:[REDACTED:${pseudonym}]`,
          signalId: 'large-file' as const,
          axisId: 'structural-fragility' as const,
          path: `[REDACTED:${pseudonym}]`,
          severity: 'medium' as const,
          message: `[REDACTED:${pseudonym}]`,
          source: 'deterministic' as const,
        },
      ],
      semanticFindings: [],
      interventions: [],
      capabilities: [],
    };

    const redacted = redactReport(report, ['secret']);

    expect(new Set(redacted.evidence.map((item) => item.evidenceId)).size).toBe(2);
    expect(diagnosisReportSchema.safeParse(redacted).success).toBe(true);
  });

  it('derives gate eligibility from observable calibration metrics', () => {
    expect(
      deriveGateEligible({
        calibrationPresent: true,
        minSamplesPerBand: true,
        hasFalsePositiveRate: true,
        hasMissRate: true,
        hasRankingQuality: true,
        hasExplanationUsefulness: true,
        goldenRegressionPassed: true,
      }, [], []),
    ).toBe(true);

    expect(
      deriveGateEligible({
        calibrationPresent: true,
        minSamplesPerBand: false,
        hasFalsePositiveRate: true,
        hasMissRate: true,
        hasRankingQuality: true,
        hasExplanationUsefulness: true,
        goldenRegressionPassed: true,
      }, [], []),
    ).toBe(false);
  });
});
