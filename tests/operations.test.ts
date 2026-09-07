import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { analyzeTrend, rankInvestmentPriorities } from '../src/operations/trend.js';
import type { TrendEntry } from '../src/schema/report.v1.js';
import { loadPolicy, policySchema } from '../src/operations/policy.js';

const root = path.dirname(fileURLToPath(import.meta.url));

describe('phase 5-6 operations', () => {
  it('REG-2026-019 rejects policy paths that escape or symlink outside the repository', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-policy-boundary-'));
    const repositoryPath = path.join(parent, 'repository');
    const outsidePath = path.join(parent, 'outside-policy.json');
    const policy = JSON.stringify({ schemaVersion: 1, requiredCalibrationConditions: [] });
    await mkdir(repositoryPath);
    await writeFile(outsidePath, policy);
    await symlink(outsidePath, path.join(repositoryPath, 'linked-policy.json'));
    try {
      await expect(loadPolicy(repositoryPath, '../outside-policy.json')).rejects.toThrow('escapes repository root');
      await expect(loadPolicy(repositoryPath, 'linked-policy.json')).rejects.toThrow('contains a symbolic link');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('bounds repository-controlled policy collections and retention', () => {
    expect(() => policySchema.parse({
      schemaVersion: 1,
      retentionDays: 36_501,
      redactPaths: Array.from({ length: 1_001 }, () => 'path'),
      requiredCalibrationConditions: [],
    })).toThrow();
  });

  it('scans monorepo unit subset', async () => {
    const repoRoot = path.join(root, '..');
    const full = await createRepositorySnapshot(repoRoot);
    const core = await createRepositorySnapshot(repoRoot, 'core');
    expect(core.files.length).toBeLessThan(full.files.length);
    expect(core.files.every((file) => file.relativePath.startsWith('src/evidence') || file.relativePath.startsWith('src/assessment'))).toBe(true);
  });

  it('analyzes trend degradation', () => {
    const entries: TrendEntry[] = [
      {
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'a',
        score: 30,
        confidence: 0.8,
        contractVersion: 3,
        commitSha: 'aaa',
        changedFiles: ['src/a.ts'],
        topClusters: [{ clusterId: 'cluster:structural-fragility:dependency-cycle:1', score: 40 }],
      },
      {
        schemaVersion: 1,
        generatedAt: '2026-01-02T00:00:00.000Z',
        inputId: 'b',
        score: 55,
        confidence: 0.8,
        contractVersion: 3,
        commitSha: 'bbb',
        changedFiles: ['src/b.ts'],
        topClusters: [{ clusterId: 'cluster:structural-fragility:dependency-cycle:1', score: 70 }],
      },
    ];
    const analysis = analyzeTrend(entries);
    expect(analysis.degradationStartAt).toBe('2026-01-01T00:00:00.000Z');
    expect(analysis.scoreDeltaFromFirst).toBe(25);
    expect(analysis.contributingClusterIds).toContain('cluster:structural-fragility:dependency-cycle:1');
    expect(analysis.contributingChanges).toHaveLength(1);
    expect(analysis.contributingChanges[0]?.commitSha).toBe('bbb');
  });

  it('detects golden score drift as calibration regression signal', async () => {
    const fragile = await runDiagnosis(
      await createRepositorySnapshot(path.join(root, 'fixtures', 'fragile-cart')),
    );
    const stable = await runDiagnosis(
      await createRepositorySnapshot(path.join(root, 'fixtures', 'stable-cart')),
    );
    expect(fragile.repository.regressionRiskScore).toBeGreaterThan(stable.repository.regressionRiskScore);
    expect(fragile.clusters.length).toBeGreaterThanOrEqual(stable.clusters.length);
    expect(fragile.evidence.length).toBeGreaterThan(stable.evidence.length);
  });

  it('ranks investment priorities by intervention priorityScore', async () => {
    const fragile = await runDiagnosis(
      await createRepositorySnapshot(path.join(root, 'fixtures', 'fragile-cart')),
    );
    const priorities = rankInvestmentPriorities(fragile);
    expect(priorities.length).toBe(fragile.interventions.length);
    expect(priorities[0]?.urgency).toBe(fragile.interventions[0]?.priorityScore);
    expect(priorities.map((entry) => entry.intervention.priority)).toEqual(
      fragile.interventions.map((item) => item.priority),
    );
    for (let index = 1; index < priorities.length; index += 1) {
      expect(priorities[index - 1]?.urgency).toBeGreaterThanOrEqual(priorities[index]?.urgency ?? 0);
    }
  });
});
