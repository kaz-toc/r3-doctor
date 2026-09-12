import { ConfigError } from '../shared/errors.js';
import type { ValidationOutcomeV1, ValidationSnapshotV1 } from './schema.js';

export type ValidationSampleState = 'pending' | 'due' | 'complete';

export type ValidationStatusSample = {
  sampleId: string;
  recordedAt: string;
  dueAt: string;
  horizonDays: number;
  state: ValidationSampleState;
  outcome?: ValidationOutcomeV1['outcome'];
  retentionExpired: boolean;
};

export type ValidationStatus = {
  counts: Record<ValidationSampleState, number>;
  samples: ValidationStatusSample[];
};

export function buildValidationStatus(
  snapshots: ValidationSnapshotV1[],
  outcomes: ValidationOutcomeV1[],
  now: Date,
  retentionDays: number,
): ValidationStatus {
  const snapshotsById = new Map(snapshots.map((sample) => [sample.sampleId, sample]));
  for (const outcome of outcomes) {
    if (!snapshotsById.has(outcome.sampleId)) {
      throw new ConfigError(`outcomes/${outcome.sampleId}.json`, 'outcome references an unknown validation sample');
    }
  }
  const outcomesById = new Map(outcomes.map((outcome) => [outcome.sampleId, outcome]));
  const counts: Record<ValidationSampleState, number> = { pending: 0, due: 0, complete: 0 };
  const samples = snapshots.map((sample) => {
    const outcome = outcomesById.get(sample.sampleId);
    const state: ValidationSampleState = outcome
      ? 'complete'
      : now.getTime() >= new Date(sample.dueAt).getTime()
        ? 'due'
        : 'pending';
    counts[state] += 1;
    const retentionAt = new Date(sample.dueAt);
    retentionAt.setUTCDate(retentionAt.getUTCDate() + retentionDays);
    return {
      sampleId: sample.sampleId,
      recordedAt: sample.recordedAt,
      dueAt: sample.dueAt,
      horizonDays: sample.horizonDays,
      state,
      outcome: outcome?.outcome,
      retentionExpired: now.getTime() >= retentionAt.getTime(),
    };
  }).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.sampleId.localeCompare(right.sampleId));
  return { counts, samples };
}
