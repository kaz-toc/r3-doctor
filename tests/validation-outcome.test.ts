import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { ConfigError } from '../src/shared/errors.js';
import { saveValidationOutcome } from '../src/validation/outcome.js';
import { computeShadowScores } from '../src/validation/shadow-score.js';
import { saveValidationSnapshot } from '../src/validation/storage.js';
import { createGitRepository } from './helpers/git-repository.js';

describe('validation outcome storage', () => {
  it('REG-2026-028 reports malformed outcome inputs as concise domain errors', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/validation/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const { sample } = await saveValidationSnapshot({
        snapshot, report, shadow: computeShadowScores(snapshot, report),
        policyThresholds: { advisory: 70, gate: 85 }, horizonDays: 30,
        recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const invalidInputs = [
        { outcome: 'bogus', occurredAt: '2026-09-02T00:00:00Z', field: 'outcome' },
        { outcome: 'regression', occurredAt: 'yesterday', field: 'occurredAt' },
        { outcome: 'regression', field: 'occurredAt' },
        { outcome: 'no-regression', occurredAt: '2026-09-02T00:00:00Z', field: 'occurredAt' },
      ];
      for (const { field, ...invalidInput } of invalidInputs) {
        const result = saveValidationOutcome(repo.path, {
          sampleId: sample.sampleId,
          ...invalidInput,
          outcome: invalidInput.outcome as 'regression',
          observedAt: new Date('2026-10-01T00:00:00.000Z'),
        });
        await expect(result).rejects.toBeInstanceOf(ConfigError);
        await expect(result).rejects.toThrow(field);
        await expect(result).rejects.not.toThrow(/"code"|"expected"|"received"/);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-028 enforces observation timing and preserves idempotent outcomes', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\n.r3-doctor/validation/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const sample = (await saveValidationSnapshot({
        snapshot, report, shadow: computeShadowScores(snapshot, report),
        policyThresholds: { advisory: 70, gate: 85 }, horizonDays: 30,
        recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      })).sample;
      await expect(saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId, outcome: 'regression',
        occurredAt: '2026-09-20T00:00:00.000Z', observedAt: new Date('2026-09-10T00:00:00.000Z'),
      })).rejects.toThrow(/occurredAt cannot be in the future/);
      await expect(saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId, outcome: 'no-regression', observedAt: new Date('2026-09-30T00:00:00.000Z'),
      })).rejects.toThrow(/before dueAt/);
      const input = {
        sampleId: sample.sampleId, outcome: 'no-regression' as const, observedAt: new Date('2026-10-01T00:00:00.000Z'),
      };
      expect((await saveValidationOutcome(repo.path, input)).status).toBe('created');
      expect((await saveValidationOutcome(repo.path, input)).status).toBe('unchanged');
    } finally {
      await repo.cleanup();
    }
  });
});
