import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { loadValidationOutcomes, saveValidationOutcome } from '../src/validation/outcome.js';
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

  it('REG-2026-028 records changed observations at the same commit without losing idempotency', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/validation/\n',
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
      const original = await saveValidationSnapshot(input);
      const changedReport = structuredClone(report);
      changedReport.repository.regressionRiskScore = 75;
      changedReport.repository.confidence = 0.75;
      const changed = await saveValidationSnapshot({ ...input, report: changedReport });
      expect(changed.status).toBe('created');
      expect(changed.sample.sampleId).not.toBe(original.sample.sampleId);
      expect(changed.sample.v4).toMatchObject({ score: 75, confidence: 0.75 });

      const changedShadow = structuredClone(input.shadow);
      changedShadow[0]!.score = 81;
      const shadowOnly = await saveValidationSnapshot({ ...input, shadow: changedShadow });
      expect(shadowOnly.status).toBe('created');
      expect(shadowOnly.sample.sampleId).not.toBe(original.sample.sampleId);

      const repeated = await saveValidationSnapshot({
        ...input,
        report: changedReport,
        recordedAt: new Date('2026-09-02T00:00:00.000Z'),
      });
      expect(repeated.status).toBe('unchanged');
      expect(repeated.sample.recordedAt).toBe('2026-09-01T00:00:00.000Z');
      const samples = await loadValidationSnapshots(repo.path);
      expect(samples).toHaveLength(3);
      expect(samples.map((sample) => sample.headSha)).toEqual([repo.headSha, repo.headSha, repo.headSha]);
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-028 ignores unrelated storage files while retaining JSON validation', async () => {
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
      const { outcome } = await saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId, outcome: 'no-regression',
        observedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      for (const directory of ['snapshots', 'outcomes']) {
        for (const name of ['.DS_Store', '.artifact.123.tmp', 'artifact.tmp']) {
          await writeFile(path.join(repo.path, '.r3-doctor/validation', directory, name), 'unrelated');
        }
      }
      expect(await loadValidationSnapshots(repo.path)).toEqual([sample]);
      expect(await loadValidationOutcomes(repo.path)).toEqual([outcome]);
      await writeFile(path.join(repo.path, '.r3-doctor/validation/snapshots/broken.json'), '{}');
      await expect(loadValidationSnapshots(repo.path)).rejects.toThrow(/validation schema failed/);
      await writeFile(path.join(repo.path, '.r3-doctor/validation/outcomes/broken.json'), '{}');
      await expect(loadValidationOutcomes(repo.path)).rejects.toThrow(/validation schema failed/);
    } finally {
      await repo.cleanup();
    }
  });
});
