import { createHash } from 'node:crypto';

import { countProductPaths } from '../assessment/capability.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { DiagnosisReport, RiskAxisId } from '../schema/report.v1.js';
import { riskAxisIdSchema } from '../schema/report.v1.js';
import { SHADOW_REGISTRY_VERSION, type ShadowScore } from './shadow-score.js';
import { validationSnapshotV1Schema, type ValidationSnapshotV1 } from './schema.js';

export type BuildValidationSnapshotInput = {
  snapshot: RepositorySnapshot;
  report: DiagnosisReport;
  shadow: ShadowScore[];
  repositoryId: string;
  policyThresholds: { advisory: number; gate: number };
  horizonDays: number;
  recordedAt: Date;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sampleId(input: BuildValidationSnapshotInput, headSha: string): string {
  return createHash('sha256').update(canonicalJson({
    repositoryId: input.repositoryId,
    reportInputId: input.report.metadata.inputId,
    headSha,
    analysisContextFingerprint: input.snapshot.analysisContextFingerprint,
    horizonDays: input.horizonDays,
    shadowRegistryVersion: SHADOW_REGISTRY_VERSION,
  })).digest('hex');
}

function axisScores(report: DiagnosisReport): Record<RiskAxisId, number | null> {
  return Object.fromEntries(riskAxisIdSchema.options.map((axisId) => {
    const axis = report.axes.find((entry) => entry.axisId === axisId);
    return [axisId, axis && !axis.unevaluated ? axis.score : null];
  })) as Record<RiskAxisId, number | null>;
}

export function buildValidationSnapshot(input: BuildValidationSnapshotInput): ValidationSnapshotV1 {
  const headSha = input.snapshot.sourceCommitSha;
  if (!headSha) {
    throw new Error('validation snapshots require a Git commit SHA');
  }
  const dueAt = new Date(input.recordedAt.getTime());
  dueAt.setUTCDate(dueAt.getUTCDate() + input.horizonDays);
  const signalCounts = Object.fromEntries(
    [...new Map(input.report.evidence.map((item) => [item.signalId, 0])).keys()]
      .sort()
      .map((signalId) => [signalId, input.report.evidence.filter((item) => item.signalId === signalId).length]),
  );
  const strengthHistogram = input.report.evidence.reduce(
    (histogram, item) => {
      histogram[item.severity] += 1;
      return histogram;
    },
    { low: 0, medium: 0, high: 0 },
  );
  return validationSnapshotV1Schema.parse({
    schemaVersion: 1,
    sampleId: sampleId(input, headSha),
    repositoryId: input.repositoryId,
    recordedAt: input.recordedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    horizonDays: input.horizonDays,
    reportInputId: input.report.metadata.inputId,
    headSha,
    assessmentContractVersion: 4,
    analysisContextFingerprint: input.snapshot.analysisContextFingerprint,
    policyThresholds: input.policyThresholds,
    v4: {
      score: input.report.repository.regressionRiskScore,
      confidence: input.report.repository.confidence,
      axisScores: axisScores(input.report),
    },
    shadow: input.shadow,
    features: {
      productPathCount: countProductPaths(input.snapshot),
      signalCounts,
      strengthHistogram,
      capabilityCoverage: input.report.repository.confidenceBreakdown.signalCoverage,
      inputCompleteness: input.report.repository.confidenceBreakdown.inputCompleteness,
    },
  });
}
