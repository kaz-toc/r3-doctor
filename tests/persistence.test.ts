import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { saveBaseline } from '../src/persistence/baseline-store.js';
import { retainBaselineEntries, retainTrendEntries } from '../src/persistence/retention.js';
import { resolveSafeStorageDir } from '../src/persistence/storage-boundary.js';
import { loadTrendHistory } from '../src/persistence/trend-store.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import type { DiagnosisReport } from '../src/schema/report.v1.js';
import { ConfigError, R3DoctorError } from '../src/shared/errors.js';
import { redactionPolicyFingerprint } from '../src/shared/redaction.js';
import { createGitRepository } from './helpers/git-repository.js';

function minimalReport(inputId: string, generatedAt: string): DiagnosisReport {
  return {
    metadata: {
      schemaVersion: 1,
      assessmentContractVersion: 3,
      generatedAt,
      inputId,
      repositoryPath: '/tmp/repository',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
    },
    repository: { regressionRiskScore: 0, confidence: 1, disclaimer: 'test' },
    axes: [],
    clusters: [],
    evidence: [],
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

describe('persistence storage boundary', () => {
  it('rejects the repository root as baseline storage without deleting unrelated JSON', async () => {
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1, baselineDir: '.' }),
      'src/a.ts': 'export const a = 1;\n',
      'victim.json': '{"keep":true}\n',
    });
    const victimPath = path.join(repo.path, 'victim.json');

    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      await utimes(victimPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
      const outcome = await saveBaseline(snapshot, report).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(ConfigError);
      expect(await readFile(victimPath, 'utf8')).toBe('{"keep":true}\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a shared control directory as baseline storage without deleting policy JSON', async () => {
    const policy = JSON.stringify({
      schemaVersion: 1,
      retentionDays: 90,
      redactPaths: [],
      requiredCalibrationConditions: [],
    });
    const repo = await createGitRepository({
      '.r3-doctor/policy.json': policy,
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1, baselineDir: '.r3-doctor' }),
      'src/a.ts': 'export const a = 1;\n',
    });
    const policyPath = path.join(repo.path, '.r3-doctor', 'policy.json');

    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      await utimes(policyPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
      const outcome = await saveBaseline(snapshot, report).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(ConfigError);
      expect(await readFile(policyPath, 'utf8')).toBe(policy);
    } finally {
      await repo.cleanup();
    }
  });

  it('permits a dedicated top-level baseline storage directory', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\nbaselines/\n',
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1, baselineDir: 'baselines' }),
      'src/a.ts': 'export const a = 1;\n',
    });

    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const result = await saveBaseline(snapshot, await runDiagnosis(snapshot));

      expect(path.dirname(result.path)).toBe(path.join(await realpath(repo.path), 'baselines'));
      expect((await lstat(result.path)).isFile()).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a case-variant top-level storage path when it aliases a shared control directory', async () => {
    const policy = JSON.stringify({
      schemaVersion: 1,
      retentionDays: 90,
      redactPaths: [],
      requiredCalibrationConditions: [],
    });
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1, baselineDir: '.R3-DOCTOR' }),
      '.r3-doctor/policy.json': policy,
      'src/a.ts': 'export const a = 1;\n',
    });
    const canonicalControlPath = await realpath(path.join(repo.path, '.r3-doctor'));
    const variantPath = path.join(repo.path, '.R3-DOCTOR');
    const variantRealPath = await realpath(variantPath).catch(() => undefined);

    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const outcome = await saveBaseline(snapshot, await runDiagnosis(snapshot)).catch((error: unknown) => error);

      if (variantRealPath === canonicalControlPath) {
        expect(outcome).toBeInstanceOf(ConfigError);
        expect(await readFile(path.join(repo.path, '.r3-doctor/policy.json'), 'utf8')).toBe(policy);
      } else {
        expect(outcome).not.toBeInstanceOf(Error);
        expect(path.dirname((outcome as Awaited<ReturnType<typeof saveBaseline>>).path)).toBe(await realpath(variantPath));
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects an intermediate storage component symlink without touching its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-storage-'));
    const repositoryPath = path.join(root, 'repository');
    const outsideDir = path.join(root, 'outside');
    const outsideBaselineDir = path.join(outsideDir, 'baselines');
    const victimPath = path.join(outsideBaselineDir, 'victim.txt');
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(outsideBaselineDir, { recursive: true });
    await writeFile(victimPath, 'keep me');
    await symlink(outsideDir, path.join(repositoryPath, '.r3-doctor'));

    try {
      await expect(resolveSafeStorageDir(repositoryPath, '.r3-doctor/baselines', 'baselineDir', false))
        .rejects.toBeInstanceOf(ConfigError);
      expect(await readFile(victimPath, 'utf8')).toBe('keep me');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a storage directory symlink without touching its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-storage-'));
    const repositoryPath = path.join(root, 'repository');
    const outsideDir = path.join(root, 'outside');
    const victimPath = path.join(outsideDir, 'victim.txt');
    await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(victimPath, 'keep me');
    await symlink(outsideDir, path.join(repositoryPath, '.r3-doctor', 'baselines'));

    try {
      await expect(resolveSafeStorageDir(repositoryPath, '.r3-doctor/baselines', 'baselineDir', false))
        .rejects.toBeInstanceOf(ConfigError);
      expect(await readFile(victimPath, 'utf8')).toBe('keep me');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a trend history symlink without reading its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-storage-'));
    const outsideHistoryPath = path.join(root, 'outside-history.jsonl');
    const historyPath = path.join(root, 'history.jsonl');
    const outsideContent = `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-02-01T00:00:00.000Z',
      inputId: 'outside',
      score: 1,
      confidence: 1,
      contractVersion: 3,
      topClusters: [],
    })}\n`;
    await writeFile(outsideHistoryPath, outsideContent);
    await symlink(outsideHistoryPath, historyPath);

    try {
      await expect(loadTrendHistory(historyPath)).rejects.toBeInstanceOf(R3DoctorError);
      expect(await readFile(outsideHistoryPath, 'utf8')).toBe(outsideContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('persistence retention', () => {
  it('aborts if the validated baseline directory is swapped for a symlink before retention', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-baseline-swap-'));
    const repositoryPath = path.join(root, 'repository');
    const outsideDirectory = path.join(root, 'outside');
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    const boundary = await resolveSafeStorageDir(
      repositoryPath,
      '.r3-doctor/baselines',
      'baselineDir',
      true,
    );
    const boundaryPath = typeof boundary === 'string' ? boundary : (boundary as { path: string }).path;
    const inputId = 'outside-victim';
    const sourceCommitSha = 'a'.repeat(40);
    const victimPath = path.join(outsideDirectory, `baseline-${inputId}-${sourceCommitSha}.json`);
    await writeFile(victimPath, JSON.stringify({
      schemaVersion: 3,
      kind: 'r3-doctor/baseline',
      inputId,
      generatedAt: '2026-01-01T00:00:00.000Z',
      assessmentContractVersion: 3,
      sourceCommitSha,
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
      analysisContextFingerprint: 'a'.repeat(64),
      report: minimalReport(inputId, '2026-01-01T00:00:00.000Z'),
    }));
    await utimes(victimPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await rename(boundaryPath, `${boundaryPath}-original`);
    await symlink(outsideDirectory, boundaryPath, 'dir');

    try {
      await expect(retainBaselineEntries(boundary as never, new Date())).rejects.toBeInstanceOf(ConfigError);
      expect((await lstat(victimPath)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes only expired validated store-owned baseline entry files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-baseline-retention-'));
    const repositoryPath = path.join(root, 'repository');
    await mkdir(repositoryPath, { recursive: true });
    const boundary = await resolveSafeStorageDir(repositoryPath, '.r3-doctor/baselines', 'baselineDir', true);
    const directory = boundary.path;
    const inputId = 'baseline-input';
    const sourceCommitSha = 'a'.repeat(40);
    const expiredPath = path.join(directory, `baseline-${inputId}-${sourceCommitSha}.json`);
    const freshPath = path.join(directory, 'fresh.json');
    const victimPath = path.join(directory, 'victim.json');
    const ignoredPath = path.join(directory, 'notes.txt');
    const nestedDirectory = path.join(directory, 'nested.json');
    await writeFile(expiredPath, JSON.stringify({
      schemaVersion: 3,
      kind: 'r3-doctor/baseline',
      inputId,
      generatedAt: '2026-01-01T00:00:00.000Z',
      assessmentContractVersion: 3,
      sourceCommitSha,
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
      analysisContextFingerprint: 'a'.repeat(64),
      report: minimalReport(inputId, '2026-01-01T00:00:00.000Z'),
    }));
    await writeFile(freshPath, '{}');
    await writeFile(victimPath, '{"keep":true}');
    await writeFile(ignoredPath, 'keep');
    await mkdir(nestedDirectory);
    await writeFile(path.join(nestedDirectory, 'child.txt'), 'keep');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cutoff = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(freshPath, '{}');

    try {
      const audit = await retainBaselineEntries(boundary, cutoff);
      await expect(lstat(expiredPath)).rejects.toThrow();
      expect((await lstat(freshPath)).isFile()).toBe(true);
      expect(await readFile(victimPath, 'utf8')).toBe('{"keep":true}');
      expect(await readFile(ignoredPath, 'utf8')).toBe('keep');
      expect((await lstat(nestedDirectory)).isDirectory()).toBe(true);
      expect(audit).toEqual({ storage: 'baseline', reason: 'expired', removedEntries: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes only expired trend entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-trend-retention-'));
    const repositoryPath = path.join(root, 'repository');
    await mkdir(repositoryPath, { recursive: true });
    const boundary = await resolveSafeStorageDir(repositoryPath, '.r3-doctor/trends', 'trendDir', true);
    const directory = boundary.path;
    const historyPath = path.join(directory, 'history.jsonl');
    await writeFile(historyPath, [
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'expired',
        score: 1,
        confidence: 1,
        contractVersion: 3,
        topClusters: [],
      }),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-02-01T00:00:00.000Z',
        inputId: 'fresh',
        score: 2,
        confidence: 1,
        contractVersion: 3,
        topClusters: [],
      }),
    ].join('\n'));

    try {
      const audit = await retainTrendEntries(boundary, new Date('2026-02-01T00:00:00.000Z'));
      expect((await loadTrendHistory(historyPath)).map((entry) => entry.inputId)).toEqual(['fresh']);
      expect(audit).toEqual({ storage: 'trend', reason: 'expired', removedEntries: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps malformed trend history unchanged and reports its line number', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-trend-retention-'));
    const repositoryPath = path.join(root, 'repository');
    await mkdir(repositoryPath, { recursive: true });
    const boundary = await resolveSafeStorageDir(repositoryPath, '.r3-doctor/trends', 'trendDir', true);
    const directory = boundary.path;
    const historyPath = path.join(directory, 'history.jsonl');
    const content = `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      inputId: 'expired',
      score: 1,
      confidence: 1,
      contractVersion: 3,
      topClusters: [],
    })}\n{broken\n`;
    await writeFile(historyPath, content);

    try {
      await expect(retainTrendEntries(boundary, new Date('2026-02-01T00:00:00.000Z')))
        .rejects.toBeInstanceOf(R3DoctorError);
      await expect(retainTrendEntries(boundary, new Date('2026-02-01T00:00:00.000Z')))
        .rejects.toThrow(/line 2/);
      expect(await readFile(historyPath, 'utf8')).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
