import { describe, expect, it } from 'vitest';

import { validationOutcomeV1Schema, validationSnapshotV1Schema } from '../src/validation/schema.js';

const sampleId = 'a'.repeat(64);
const axisScores = {
  'structural-fragility': 1,
  'change-blast-radius': null,
  'verification-gap': 2,
  'change-volatility': 3,
  'semantic-ambiguity': null,
};

function snapshot() {
  return {
    schemaVersion: 1,
    sampleId,
    repositoryId: '123e4567-e89b-12d3-a456-426614174000',
    recordedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-10-01T00:00:00.000Z',
    horizonDays: 30,
    reportInputId: 'input',
    headSha: 'a'.repeat(40),
    assessmentContractVersion: 4,
    analysisContextFingerprint: 'b'.repeat(64),
    policyThresholds: { advisory: 70, gate: 85 },
    v4: { score: 1, confidence: 0.5, axisScores },
    shadow: ['v5-activity-modifier', 'v5-combined', 'v5-confidence-uplift', 'v5-soft-saturation'].map((candidateId) => ({
      candidateId,
      formulaVersion: 1,
      score: 1,
      axisScores,
      scoreBreakdown: { core: 1, activityUplift: 0, clusterUplift: 0 },
    })),
    features: {
      productPathCount: 1,
      signalCounts: { 'large-file': 1 },
      strengthHistogram: { low: 1, medium: 0, high: 0 },
      capabilityCoverage: 1,
      inputCompleteness: 1,
    },
  };
}

describe('validation artifact schemas', () => {
  it('accepts complete privacy-safe snapshots and rejects unknown keys', () => {
    expect(validationSnapshotV1Schema.safeParse(snapshot()).success).toBe(true);
    expect(validationSnapshotV1Schema.safeParse({ ...snapshot(), path: '/secret' }).success).toBe(false);
    expect(validationSnapshotV1Schema.safeParse({ ...snapshot(), shadow: snapshot().shadow.slice(1) }).success).toBe(false);
  });

  it('enforces outcome type and timestamp rules', () => {
    expect(validationOutcomeV1Schema.safeParse({
      schemaVersion: 1, sampleId, observedAt: '2026-10-01T00:00:00.000Z', outcome: 'regression', occurredAt: '2026-09-02T00:00:00.000Z',
    }).success).toBe(true);
    expect(validationOutcomeV1Schema.safeParse({
      schemaVersion: 1, sampleId, observedAt: '2026-10-01T00:00:00.000Z', outcome: 'no-regression', occurredAt: '2026-09-02T00:00:00.000Z',
    }).success).toBe(false);
    expect(validationOutcomeV1Schema.safeParse({
      schemaVersion: 1, sampleId, observedAt: '2026-10-01T00:00:00.000Z', outcome: 'hotfix',
    }).success).toBe(false);
  });
});
