import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runScanAction } from '../src/commands/scan.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { compareValidationModels } from '../src/validation/evaluate.js';
import { saveValidationOutcome } from '../src/validation/outcome.js';
import { computeShadowScores } from '../src/validation/shadow-score.js';
import { buildValidationStatus } from '../src/validation/status.js';
import { loadValidationSnapshots, saveValidationSnapshot } from '../src/validation/storage.js';
import { validationOutcomeV1Schema, validationSnapshotV1Schema } from '../src/validation/schema.js';
import { createGitRepository } from './helpers/git-repository.js';

describe('validation issue regressions', () => {
  it('accepts decimal policy thresholds and ISO timestamps without milliseconds', () => {
    const parsed = validationSnapshotV1Schema.safeParse({
      schemaVersion: 1,
      sampleId: 'a'.repeat(64),
      repositoryId: '123e4567-e89b-12d3-a456-426614174000',
      recordedAt: '2026-09-01T00:00:00Z',
      dueAt: '2026-10-01T00:00:00Z',
      horizonDays: 30,
      reportInputId: 'input',
      headSha: 'a'.repeat(40),
      assessmentContractVersion: 4,
      analysisContextFingerprint: 'b'.repeat(64),
      policyThresholds: { advisory: 72.5, gate: 60 },
      v4: {
        score: 1,
        confidence: 0.5,
        axisScores: {
          'structural-fragility': 1,
          'change-blast-radius': null,
          'verification-gap': 2,
          'change-volatility': 3,
          'semantic-ambiguity': null,
        },
      },
      shadow: ['v5-activity-modifier', 'v5-combined', 'v5-confidence-uplift', 'v5-soft-saturation'].map((candidateId) => ({
        candidateId,
        formulaVersion: 1,
        score: 1,
        axisScores: {
          'structural-fragility': 1,
          'change-blast-radius': null,
          'verification-gap': 2,
          'change-volatility': 3,
          'semantic-ambiguity': null,
        },
        scoreBreakdown: { core: 1, activityUplift: 0, clusterUplift: 0 },
      })),
      features: {
        productPathCount: 1,
        signalCounts: { 'large-file': 1 },
        strengthHistogram: { low: 1, medium: 0, high: 0 },
        capabilityCoverage: 1,
        inputCompleteness: 1,
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.recordedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(validationOutcomeV1Schema.safeParse({
      schemaVersion: 1,
      sampleId: 'a'.repeat(64),
      observedAt: '2026-10-01T00:00:00Z',
      outcome: 'regression',
      occurredAt: '2026-09-02T00:00:00Z',
    }).success).toBe(true);
  });

  it('treats equivalent rescan payloads as unchanged instead of duplicate conflict', async () => {
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
      expect((await saveValidationSnapshot(input)).status).toBe('created');
      expect((await saveValidationSnapshot(input)).status).toBe('unchanged');
    } finally {
      await repo.cleanup();
    }
  });

  it('writes scan output before validation save failures and rejects oversized horizons', async () => {
    const horizonRepo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await expect(runScanAction({
        repoPath: horizonRepo.path,
        format: 'json',
        recordValidation: true,
        validationHorizonDays: '9999',
      })).rejects.toThrow(/at most 365/);
    } finally {
      await horizonRepo.cleanup();
    }

    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await runScanAction({ repoPath: repo.path, format: 'json', recordValidation: true });
      const stdout: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return originalWrite(chunk as never, ...(args as never[]));
      }) as typeof process.stdout.write;
      try {
        await expect(runScanAction({
          repoPath: repo.path,
          format: 'json',
          recordValidation: true,
        })).rejects.toThrow(/uncommitted changes|dirty|worktree|validation/i);
        expect(stdout.join('')).toContain('"assessmentContractVersion": 4');
      } finally {
        process.stdout.write = originalWrite;
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('excludes pre-due samples from compare and marks non-primary cohorts exploratory', () => {
    const sampleId = 'a'.repeat(64);
    const snapshot = {
      schemaVersion: 1 as const,
      sampleId,
      repositoryId: '123e4567-e89b-12d3-a456-426614174000',
      recordedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-10-01T00:00:00.000Z',
      horizonDays: 45,
      reportInputId: 'input',
      headSha: 'a'.repeat(40),
      assessmentContractVersion: 4 as const,
      analysisContextFingerprint: 'b'.repeat(64),
      policyThresholds: { advisory: 70, gate: 85 },
      v4: { score: 80, confidence: 0.5, axisScores: {
        'structural-fragility': 80, 'change-blast-radius': null, 'verification-gap': null, 'change-volatility': null, 'semantic-ambiguity': null,
      } },
      shadow: ['v5-activity-modifier', 'v5-combined', 'v5-confidence-uplift', 'v5-soft-saturation'].map((candidateId) => ({
        candidateId,
        formulaVersion: 1 as const,
        score: 80,
        axisScores: {
          'structural-fragility': 80, 'change-blast-radius': null, 'verification-gap': null, 'change-volatility': null, 'semantic-ambiguity': null,
        },
        scoreBreakdown: { core: 80, activityUplift: 0, clusterUplift: 0 },
      })),
      features: {
        productPathCount: 1,
        signalCounts: { 'large-file': 1 },
        strengthHistogram: { low: 0, medium: 1, high: 0 },
        capabilityCoverage: 1,
        inputCompleteness: 1,
      },
    };
    const outcome = {
      schemaVersion: 1 as const,
      sampleId,
      observedAt: '2026-09-15T00:00:00.000Z',
      outcome: 'regression' as const,
      occurredAt: '2026-09-10T00:00:00.000Z',
    };
    const beforeDue = compareValidationModels({
      snapshots: [snapshot],
      outcomes: [outcome],
      goldenOrdering: { v4: true, 'v5-activity-modifier': true, 'v5-combined': true, 'v5-confidence-uplift': true, 'v5-soft-saturation': true },
      repositoryValidationPassed: false,
      now: new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(beforeDue.corpus.completeSampleCount).toBe(0);
    const exploratory = compareValidationModels({
      snapshots: [snapshot],
      outcomes: [outcome],
      goldenOrdering: { v4: true, 'v5-activity-modifier': true, 'v5-combined': true, 'v5-confidence-uplift': true, 'v5-soft-saturation': true },
      repositoryValidationPassed: false,
      now: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(exploratory.corpus.completeSampleCount).toBe(1);
    expect(exploratory.primary).toHaveLength(0);
    expect(exploratory.exploratory[0]?.promotionStatus).toBe('exploratory');
  });

  it('supports outcome replacement and orphan outcome warnings', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/validation/\n',
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
      const created = await saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId,
        outcome: 'regression',
        occurredAt: '2026-09-10T00:00:00.000Z',
        observedAt: new Date('2026-09-11T00:00:00.000Z'),
      });
      expect(created.status).toBe('created');
      await expect(saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId,
        outcome: 'hotfix',
        occurredAt: '2026-09-12T00:00:00.000Z',
        observedAt: new Date('2026-09-13T00:00:00.000Z'),
      })).rejects.toThrow(/different content/);
      const replaced = await saveValidationOutcome(repo.path, {
        sampleId: sample.sampleId,
        outcome: 'hotfix',
        occurredAt: '2026-09-12T00:00:00.000Z',
        observedAt: new Date('2026-09-13T00:00:00.000Z'),
        replace: true,
      });
      expect(replaced.status).toBe('replaced');
      const status = buildValidationStatus([], [replaced.outcome], new Date('2026-09-14T00:00:00.000Z'), 90);
      expect(status.warnings[0]).toContain('missing validation sample');
    } finally {
      await repo.cleanup();
    }
  });

  it('does not create validation storage for non-git repositories', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-nogit-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src/a.ts'), 'export const a = 1;\n');
      const snapshot = await createRepositorySnapshot(repositoryPath);
      const report = await runDiagnosis(snapshot);
      await expect(saveValidationSnapshot({
        snapshot, report, shadow: computeShadowScores(snapshot, report),
        policyThresholds: { advisory: 70, gate: 85 }, horizonDays: 30,
      })).rejects.toThrow(/Git commit SHA|Git repository/);
      expect(await loadValidationSnapshots(repositoryPath)).toEqual([]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('derives sample IDs from policy thresholds', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/validation/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const shadow = computeShadowScores(snapshot, report);
      const first = await saveValidationSnapshot({
        snapshot, report, shadow,
        policyThresholds: { advisory: 70, gate: 85 }, horizonDays: 30,
        recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const second = await saveValidationSnapshot({
        snapshot, report, shadow,
        policyThresholds: { advisory: 72.5, gate: 85 }, horizonDays: 30,
        recordedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(first.sample.sampleId).not.toBe(second.sample.sampleId);
    } finally {
      await repo.cleanup();
    }
  });
});
