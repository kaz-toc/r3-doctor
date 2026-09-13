import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { computeShadowScores } from '../src/validation/shadow-score.js';
import { loadValidationSnapshots, saveValidationSnapshot } from '../src/validation/storage.js';
import { createGitRepository } from './helpers/git-repository.js';

describe('validation snapshot storage', () => {
  it('creates a stable private identity and treats equivalent samples as unchanged', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\n.r3-doctor/validation/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const input = {
        snapshot,
        report,
        shadow: computeShadowScores(snapshot, report),
        policyThresholds: { advisory: 70, gate: 85 },
        horizonDays: 30,
        recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      };
      const created = await saveValidationSnapshot(input);
      const unchanged = await saveValidationSnapshot(input);
      expect(created.status).toBe('created');
      expect(unchanged.status).toBe('unchanged');
      expect((await loadValidationSnapshots(repo.path)).map((sample) => sample.sampleId)).toEqual([created.sample.sampleId]);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not create storage while loading a missing validation directory', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      expect(await loadValidationSnapshots(repo.path)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});
