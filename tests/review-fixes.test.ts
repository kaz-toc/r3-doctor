import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { computeBlastRadius } from '../src/commands/diff.js';
import { runDiffDiagnosis } from '../src/commands/diff.js';
import { blastRadiusEntrySchema, diffReportSchema } from '../src/schema/report.v1.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { saveBaseline } from '../src/persistence/baseline-store.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { IntakeError } from '../src/shared/errors.js';
import { redactDiffReport, redactionPolicyFingerprint } from '../src/shared/redaction.js';
import { ConfigError } from '../src/shared/errors.js';
import { resolveSafeStorageDir } from '../src/persistence/storage-boundary.js';
import { analyzeTrend } from '../src/operations/trend.js';
import type { TrendEntry } from '../src/schema/report.v1.js';
import { createGitRepository } from './helpers/git-repository.js';

const execFileAsync = promisify(execFile);

describe('review fixes', () => {
  it('rejects storage directories that escape repository root', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-storage-root-'));
    try {
      await expect(resolveSafeStorageDir(repository, '..', 'baselineDir', false)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('computes blast radius paths without import edge kind field', () => {
    const files = [
      { relativePath: 'src/a.ts' },
      { relativePath: 'src/b.ts' },
    ];
    const radius = computeBlastRadius(['src/a.ts'], '/repo', files);
    expect(blastRadiusEntrySchema.safeParse(radius[0]).success).toBe(true);
  });

  it('redacts diff comparison paths and signal identifiers', async () => {
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current: {
        metadata: {
          schemaVersion: 1,
          assessmentContractVersion: 3,
          generatedAt: '2026-01-01T00:00:00.000Z',
          inputId: 'c',
          repositoryPath: '/tmp/secret-repo',
          analyzers: [],
          truncated: false,
          unevaluatedAreas: [],
        },
        repository: { regressionRiskScore: 10, confidence: 1, disclaimer: 'd' },
        axes: [],
        clusters: [],
        evidence: [{
          evidenceId: 'evidence:dep-cycle:secret-repo/src/a.ts',
          signalId: 'dep-cycle',
          axisId: 'structural-fragility',
          path: 'secret-repo/src/a.ts',
          severity: 'high',
          message: 'secret-repo cycle',
          source: 'deterministic',
        }],
        semanticFindings: [],
        interventions: [],
        capabilities: [],
      },
      base: {
        metadata: {
          schemaVersion: 1,
          assessmentContractVersion: 3,
          generatedAt: '2026-01-01T00:00:00.000Z',
          inputId: 'b',
          repositoryPath: '/tmp/secret-repo',
          analyzers: [],
          truncated: false,
          unevaluatedAreas: [],
        },
        repository: { regressionRiskScore: 5, confidence: 1, disclaimer: 'd' },
        axes: [],
        clusters: [],
        evidence: [],
        semanticFindings: [],
        interventions: [],
        capabilities: [],
      },
      comparison: {
        compatible: true,
        riskDelta: 5,
        baselineId: 'b',
        changedFiles: ['secret-repo/src/a.ts'],
        blastRadius: [{
          changedFile: 'secret-repo/src/a.ts',
          directDependents: [],
          directDependencies: [],
          transitiveDependents: [],
          transitiveDependencies: [],
          paths: [],
        }],
        newSignals: [{
          evidenceId: 'evidence:dep-cycle:secret-repo/src/a.ts',
          signalId: 'dep-cycle',
          path: 'secret-repo/src/a.ts',
          currentSeverity: 'high',
          message: 'secret-repo cycle',
        }],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const redacted = redactDiffReport(diff, ['secret-repo']);
    const redactedAgain = redactDiffReport(redacted, ['secret-repo']);
    expect(JSON.stringify(redacted)).not.toContain('secret-repo');
    expect(redactedAgain).toEqual(redacted);
    expect(redacted.redactionPolicyFingerprint).toBe(redactionPolicyFingerprint(['secret-repo']));
  });

  it('rejects missing repository roots with intake error', async () => {
    await expect(createRepositorySnapshot('/path/that/does/not/exist/r3-doctor')).rejects.toBeInstanceOf(IntakeError);
  });

  it('suppresses score comparison when no stored baseline exists', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);
      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('no stored baseline manifest');
      expect(diff.comparison.riskDelta).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('compares against stored baseline when manifest exists', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await execFileAsync('git', ['checkout', '--detach', repo.baseSha], { cwd: repo.path });
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const baseline = await saveBaseline(snapshot, report);
      try {
        await execFileAsync('git', ['checkout', '--detach', repo.headSha], { cwd: repo.path });
        const diff = await runDiffDiagnosis(repo.path, repo.baseSha);
        expect(diff.comparison.compatible).toBe(true);
        expect(diff.comparison.baselineId).toBeDefined();
      } finally {
        await rm(baseline.path, { force: true });
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('finds degradation start across interim improvements', () => {
    const entries: TrendEntry[] = [
      { schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z', inputId: 'a', score: 10, confidence: 1, contractVersion: 3, topClusters: [] },
      { schemaVersion: 1, generatedAt: '2026-01-02T00:00:00.000Z', inputId: 'b', score: 20, confidence: 1, contractVersion: 3, topClusters: [] },
      { schemaVersion: 1, generatedAt: '2026-01-03T00:00:00.000Z', inputId: 'c', score: 15, confidence: 1, contractVersion: 3, topClusters: [] },
      { schemaVersion: 1, generatedAt: '2026-01-04T00:00:00.000Z', inputId: 'd', score: 25, confidence: 1, contractVersion: 3, topClusters: [] },
      { schemaVersion: 1, generatedAt: '2026-01-05T00:00:00.000Z', inputId: 'e', score: 24, confidence: 1, contractVersion: 3, topClusters: [] },
    ];
    expect(analyzeTrend(entries).degradationStartAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates two commits without seed files', async () => {
    const repo = await createGitRepository();
    try {
      const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo.path });
      expect(stdout.trim()).toBe('2');
      expect(repo.baseSha).not.toBe(repo.headSha);
    } finally {
      await repo.cleanup();
    }
  });
});
