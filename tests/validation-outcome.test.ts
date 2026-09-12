import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { saveValidationOutcome } from '../src/validation/outcome.js';
import { computeShadowScores } from '../src/validation/shadow-score.js';
import { saveValidationSnapshot } from '../src/validation/storage.js';
import { createGitRepository } from './helpers/git-repository.js';

describe('validation outcome storage', () => {
  it('enforces observation timing and preserves idempotent outcomes', async () => {
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
