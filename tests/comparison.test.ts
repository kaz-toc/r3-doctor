import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { compareDiagnosis, compareSignalChanges } from '../src/comparison/compare.js';
import { runDiffDiagnosis } from '../src/commands/diff.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { diagnosisContextFingerprint } from '../src/intake/analysis-context.js';
import { loadBaseline, saveBaseline } from '../src/persistence/baseline-store.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import type { AnalyzerPlugin } from '../src/plugins/analyzer.js';
import { baselineEntrySchema } from '../src/schema/report.v1.js';
import type { BaselineEntry, DiagnosisReport } from '../src/schema/report.v1.js';
import { ConfigError } from '../src/shared/errors.js';
import { redactionPolicyFingerprint } from '../src/shared/redaction.js';
import { redactReport } from '../src/shared/redaction.js';
import { createGitRepository } from './helpers/git-repository.js';

const execFileAsync = promisify(execFile);

function versionedAnalyzer(
  implementationVersion: string,
  contractVersion: number,
  emitHighRiskEvidence: boolean,
  id = 'same-analyzer',
): AnalyzerPlugin {
  return {
    id,
    implementationVersion,
    extensions: ['.ts'],
    capabilities: [{
      language: 'typescript-javascript',
      contractVersion,
      signals: ['large-file'],
      completeness: 'partial',
    }],
    extract: async () => emitHighRiskEvidence ? [{
      evidenceId: 'evidence:large-file:src/a.ts',
      signalId: 'large-file',
      axisId: 'structural-fragility',
      path: 'src/a.ts',
      severity: 'high',
      message: 'versioned analyzer high-risk result',
      source: 'deterministic',
    }] : [],
  };
}

async function compareAgainstSavedBaseline(
  snapshot: Awaited<ReturnType<typeof createRepositorySnapshot>>,
  current: DiagnosisReport,
  sourceCommitSha: string,
) {
  const stored = await loadBaseline(snapshot, sourceCommitSha);
  return compareDiagnosis(current, stored.entry, {
    resolvedBaseSha: sourceCommitSha,
    redactPaths: [],
    redactionPolicyFingerprint: redactionPolicyFingerprint([]),
    analysisContextFingerprint: diagnosisContextFingerprint(snapshot.analysisContextFingerprint, current),
    changedFiles: [],
    blastRadius: [],
  });
}

async function checkout(repositoryPath: string, ref: string): Promise<void> {
  await execFileAsync('git', ['checkout', '--detach', ref], { cwd: repositoryPath });
}

function minimalReport(inputId: string): DiagnosisReport {
  return {
    metadata: {
      schemaVersion: 1,
      assessmentContractVersion: 3,
      generatedAt: '2026-01-01T00:00:00.000Z',
      inputId,
      repositoryPath: '/tmp/secret-repo',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
    },
    repository: { regressionRiskScore: 10, confidence: 1, disclaimer: 'test' },
    axes: [],
    clusters: [],
    evidence: [],
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

describe('pure comparison', () => {
  it('preserves distinct redacted evidence identities so removals remain visible', () => {
    const evidence = (secret: string) => ({
      evidenceId: `evidence:large-file:${secret}/same.ts`,
      signalId: 'large-file' as const,
      axisId: 'structural-fragility' as const,
      path: `${secret}/same.ts`,
      severity: 'medium' as const,
      message: `large file at ${secret}/same.ts`,
      source: 'deterministic' as const,
    });
    const first = evidence('secret-a');
    const second = evidence('secret-b');
    const base = { ...minimalReport('base'), evidence: [first, second] };
    const current = { ...minimalReport('current'), evidence: [first] };
    const policy = ['secret-a', 'secret-b'];
    const redactedBase = redactReport(base, policy);
    const redactedCurrent = redactReport(current, policy);

    const changes = compareSignalChanges(redactedCurrent, redactedBase);

    expect(new Set(redactedBase.evidence.map((item) => item.evidenceId)).size).toBe(2);
    expect(changes.improvedSignals).toHaveLength(1);
    expect(JSON.stringify(changes)).not.toContain('secret-a');
    expect(JSON.stringify(changes)).not.toContain('secret-b');
  });

  it('suppresses baseline-derived values when the redaction policy differs', () => {
    const current = minimalReport('current');
    const baseline: BaselineEntry = {
      schemaVersion: 3,
      kind: 'r3-doctor/baseline',
      inputId: 'baseline',
      generatedAt: '2026-01-01T00:00:00.000Z',
      assessmentContractVersion: 3,
      sourceCommitSha: 'base-sha',
      redactionPolicyFingerprint: 'saved-policy',
      analysisContextFingerprint: 'analysis-context',
      report: minimalReport('baseline'),
    };

    const result = compareDiagnosis(current, baseline, {
      resolvedBaseSha: 'base-sha',
      redactPaths: ['secret-repo'],
      redactionPolicyFingerprint: 'current-policy',
      analysisContextFingerprint: 'analysis-context',
      changedFiles: [],
      blastRadius: [],
    });

    expect(result.base).toBeUndefined();
    expect(result.comparison.compatible).toBe(false);
    expect(result.comparison.reason).toContain('redaction policy mismatch');
    expect(result.comparison.riskDelta).toBeUndefined();
    expect(result.comparison.newSignals).toEqual([]);
    expect(current.metadata.repositoryPath).toBe('/tmp/secret-repo');
  });

  it('suppresses baseline-derived values when the analysis context differs', () => {
    const current = minimalReport('current');
    const baseline = {
      schemaVersion: 3,
      kind: 'r3-doctor/baseline',
      inputId: 'baseline',
      generatedAt: '2026-01-01T00:00:00.000Z',
      assessmentContractVersion: 3,
      sourceCommitSha: 'base-sha',
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
      analysisContextFingerprint: 'baseline-context',
      report: minimalReport('baseline'),
    } as BaselineEntry;

    const result = compareDiagnosis(current, baseline, {
      resolvedBaseSha: 'base-sha',
      redactPaths: [],
      redactionPolicyFingerprint: redactionPolicyFingerprint([]),
      analysisContextFingerprint: 'current-context',
      changedFiles: [],
      blastRadius: [],
    });

    expect(result.base).toBeUndefined();
    expect(result.comparison.compatible).toBe(false);
    expect(result.comparison.reason).toContain('analysis context mismatch');
    expect(result.comparison.riskDelta).toBeUndefined();
  });
});

describe('commit-bound baseline comparison', () => {
  it('suppresses every baseline-derived field when the saved commit does not match --base', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const saved = await saveBaseline(snapshot, await runDiagnosis(snapshot));

      const unmatched = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(unmatched.comparison.compatible).toBe(false);
      expect(unmatched.base).toBeUndefined();
      expect(unmatched.comparison.baselineId).toBeUndefined();
      expect(unmatched.comparison.riskDelta).toBeUndefined();
      expect(unmatched.comparison.newSignals).toEqual([]);
      expect(unmatched.comparison.worsenedSignals).toEqual([]);
      expect(unmatched.comparison.improvedSignals).toEqual([]);
      expect(await readFile(saved.path, 'utf8')).toContain(repo.headSha);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a unit-scoped baseline for whole-repository comparison at the same commit', async () => {
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({
        schemaVersion: 1,
        units: [{ id: 'core', roots: ['src/core'] }],
      }),
      'src/core/a.ts': 'export const a = 1;\n',
      'src/other/b.ts': 'export const b = 1;\n',
    });
    try {
      const unitSnapshot = await createRepositorySnapshot(repo.path, 'core');
      await saveBaseline(unitSnapshot, await runDiagnosis(unitSnapshot));

      const diff = await runDiffDiagnosis(repo.path, repo.headSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('analysis context mismatch');
      expect(diff.base).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a same-commit baseline when score-affecting configuration changes', async () => {
    const configPath = 'r3-doctor.config.json';
    const repo = await createGitRepository({
      [configPath]: JSON.stringify({ schemaVersion: 1, maxFileLines: 100 }),
      'src/a.ts': 'export const a = 1;\nexport const b = 2;\n',
    });
    try {
      await checkout(repo.path, repo.baseSha);
      const baselineSnapshot = await createRepositorySnapshot(repo.path);
      await saveBaseline(baselineSnapshot, await runDiagnosis(baselineSnapshot));
      await checkout(repo.path, repo.headSha);
      await repo.write(configPath, JSON.stringify({ schemaVersion: 1, maxFileLines: 1 }));
      await repo.commit('change analysis threshold');

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('analysis context mismatch');
      expect(diff.base).toBeUndefined();
      expect(diff.comparison.riskDelta).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a same-commit baseline when llm configuration changes', async () => {
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1 }),
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      await checkout(repo.path, repo.baseSha);
      const baselineSnapshot = await createRepositorySnapshot(repo.path);
      await saveBaseline(baselineSnapshot, await runDiagnosis(baselineSnapshot));
      await checkout(repo.path, repo.headSha);

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha, {
        enabled: true,
        provider: 'codex',
        maxFiles: 20,
        sendScope: 'all',
        maxPromptBytes: 80_000,
      });

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('analysis context mismatch');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to bind a dirty analyzed snapshot to the clean HEAD commit', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await repo.write('src/a.ts', `${'export const value = 1;\n'.repeat(900)}`);
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const outcome = await saveBaseline(snapshot, report).catch((error: unknown) => error);

      expect(snapshot.gitDirty).toBe(true);
      expect(outcome).toBeInstanceOf(ConfigError);
      expect(String(outcome)).toContain('dirty');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to bind an ignored analyzed source file to HEAD', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\nsrc/generated.ts\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/generated.ts': 'export const generated = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const outcome = await saveBaseline(snapshot, await runDiagnosis(snapshot)).catch((error: unknown) => error);

      expect(snapshot.files.map((file) => file.relativePath)).toContain('src/generated.ts');
      expect(snapshot.gitDirty).toBe(true);
      expect(outcome).toBeInstanceOf(ConfigError);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to save a report produced from a different snapshot', async () => {
    const first = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    const second = await createGitRepository({ 'src/b.ts': 'export const b = 2;\n' });
    try {
      const firstSnapshot = await createRepositorySnapshot(first.path);
      const secondSnapshot = await createRepositorySnapshot(second.path);
      const foreignReport = await runDiagnosis(secondSnapshot);

      const outcome = await saveBaseline(firstSnapshot, foreignReport).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(ConfigError);
      expect(String(outcome)).toContain('does not match');
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });

  it('rejects the same analyzer identity when its immutable implementation version changes', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const baselineReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('1.0.0', 2, false)],
      });
      await saveBaseline(snapshot, baselineReport);
      const currentReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('2.0.0', 2, true)],
      });

      const comparison = await compareAgainstSavedBaseline(snapshot, currentReport, repo.headSha);

      expect(baselineReport.repository.regressionRiskScore).toBe(0);
      expect(currentReport.repository.regressionRiskScore).toBe(75);
      expect(comparison.comparison.compatible).toBe(false);
      expect(comparison.comparison.reason).toContain('analysis context mismatch');
    } finally {
      await repo.cleanup();
    }
  });

  it('fingerprints every same-language analyzer that can contribute evidence', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const baselineReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [
          versionedAnalyzer('1.0.0', 2, false, 'first-analyzer'),
          versionedAnalyzer('1.0.0', 2, false, 'second-analyzer'),
        ],
      });
      await saveBaseline(snapshot, baselineReport);
      const currentReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [
          versionedAnalyzer('1.0.0', 2, false, 'first-analyzer'),
          versionedAnalyzer('2.0.0', 2, true, 'second-analyzer'),
        ],
      });

      const comparison = await compareAgainstSavedBaseline(snapshot, currentReport, repo.headSha);

      expect(baselineReport.repository.regressionRiskScore).toBe(0);
      expect(currentReport.repository.regressionRiskScore).toBe(75);
      expect(currentReport.capabilities.map((capability) => [
        capability.analyzerId,
        capability.analyzerImplementationVersion,
        capability.contractVersion,
      ])).toEqual([
        ['first-analyzer', '1.0.0', 2],
        ['second-analyzer', '2.0.0', 2],
      ]);
      expect(comparison.comparison.compatible).toBe(false);
      expect(comparison.comparison.reason).toContain('analysis context mismatch');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects the same analyzer implementation when its capability contract version changes', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      await saveBaseline(snapshot, await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('1.0.0', 2, false)],
      }));
      const currentReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('1.0.0', 3, false)],
      });

      const comparison = await compareAgainstSavedBaseline(snapshot, currentReport, repo.headSha);

      expect(comparison.comparison.compatible).toBe(false);
      expect(comparison.comparison.reason).toContain('analysis context mismatch');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects the same semantic provider name when its implementation version changes', async () => {
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({ schemaVersion: 1 }),
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path, undefined, {
        enabled: true,
        provider: 'codex',
        maxFiles: 1,
        sendScope: 'all',
        maxPromptBytes: 80_000,
      });
      const baselineReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('1.0.0', 2, false)],
        semanticProviderFactory: {
          create: () => ({
            status: 'available' as const,
            provider: {
              name: 'same-provider',
              implementationVersion: '1.0.0',
              analyze: async () => [],
            },
          }),
        },
      });
      await saveBaseline(snapshot, baselineReport);
      const currentReport = await runDiagnosis(snapshot, {
        analyzerPlugins: [versionedAnalyzer('1.0.0', 2, false)],
        semanticProviderFactory: {
          create: () => ({
            status: 'available' as const,
            provider: {
              name: 'same-provider',
              implementationVersion: '2.0.0',
              analyze: async () => [{
                findingId: 'finding:semantic:versioned',
                axisId: 'semantic-ambiguity' as const,
                path: 'src/a.ts',
                summary: 'versioned semantic result',
                relatedEvidenceIds: [],
                confidence: 1,
              }],
            },
          }),
        },
      });

      const comparison = await compareAgainstSavedBaseline(snapshot, currentReport, repo.headSha);

      expect(currentReport.repository.regressionRiskScore).not.toBe(baselineReport.repository.regressionRiskScore);
      expect(comparison.comparison.compatible).toBe(false);
      expect(comparison.comparison.reason).toContain('analysis context mismatch');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses a commit-bound save when HEAD changed after intake', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      await repo.write('src/a.ts', 'export const a = 2;\n');
      await repo.commit('move head after intake');

      const outcome = await saveBaseline(snapshot, report).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(ConfigError);
      expect(String(outcome)).toContain('HEAD changed');
    } finally {
      await repo.cleanup();
    }
  });

  it('derives the displayed base and risk delta from the one commit-matched baseline', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await checkout(repo.path, repo.baseSha);
      const baseSnapshot = await createRepositorySnapshot(repo.path);
      const saved = await saveBaseline(baseSnapshot, await runDiagnosis(baseSnapshot));
      const savedEntry = baselineEntrySchema.parse(JSON.parse(await readFile(saved.path, 'utf8')));
      await checkout(repo.path, repo.headSha);

      const matched = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(matched.comparison.compatible).toBe(true);
      expect(matched.base?.metadata.inputId).toBe(savedEntry.report.metadata.inputId);
      expect((matched.base?.repository.regressionRiskScore ?? 0) + (matched.comparison.riskDelta ?? 0))
        .toBe(matched.current.repository.regressionRiskScore);
      expect(matched.comparison.baselineId).toBe(savedEntry.inputId);
    } finally {
      await repo.cleanup();
    }
  });

  it('preserves baselines for different commits that have the same analysis input ID', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await checkout(repo.path, repo.baseSha);
      const baseSnapshot = await createRepositorySnapshot(repo.path);
      const baseSaved = await saveBaseline(baseSnapshot, await runDiagnosis(baseSnapshot));
      const baseEntry = baselineEntrySchema.parse(JSON.parse(await readFile(baseSaved.path, 'utf8')));

      await checkout(repo.path, repo.headSha);
      const headSnapshot = await createRepositorySnapshot(repo.path);
      const headSaved = await saveBaseline(headSnapshot, await runDiagnosis(headSnapshot));
      const headEntry = baselineEntrySchema.parse(JSON.parse(await readFile(headSaved.path, 'utf8')));

      expect(baseEntry.inputId).toBe(headEntry.inputId);
      expect(baseSaved.path).not.toBe(headSaved.path);
      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);
      expect(diff.comparison.compatible).toBe(true);
      expect(diff.base?.metadata.inputId).toBe(baseEntry.report.metadata.inputId);
    } finally {
      await repo.cleanup();
    }
  });

  it('compares a redacted current copy without mutating the raw current report', async () => {
    const repo = await createGitRepository({
      '.r3-doctor/policy.json': JSON.stringify({
        schemaVersion: 1,
        redactPaths: ['secret-repo'],
        requiredCalibrationConditions: [],
      }),
      'secret-repo/a.ts': 'export const untested = 1;\n',
    });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const raw = await runDiagnosis(snapshot);
      await saveBaseline(snapshot, raw);

      const redacted = await runDiffDiagnosis(repo.path, repo.headSha);

      expect(redacted.comparison.compatible).toBe(true);
      expect(redacted.comparison.newSignals).toEqual([]);
      expect(redacted.comparison.worsenedSignals).toEqual([]);
      expect(redacted.comparison.improvedSignals).toEqual([]);
      expect(JSON.stringify(raw)).toContain('secret-repo');
      expect(JSON.stringify(redacted.current)).not.toContain('secret-repo');
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps reordered overlapping redaction policies compatible without false signal changes', async () => {
    const repo = await createGitRepository({
      '.r3-doctor/policy.json': JSON.stringify({
        schemaVersion: 1,
        redactPaths: ['secret', 'secret-repo'],
        requiredCalibrationConditions: [],
      }),
      'secret-repo/a.ts': 'export const untested = 1;\n',
    });
    try {
      const policyPath = path.join(repo.path, '.r3-doctor', 'policy.json');
      const snapshot = await createRepositorySnapshot(repo.path);
      await saveBaseline(snapshot, await runDiagnosis(snapshot));
      await writeFile(
        policyPath,
        JSON.stringify({ schemaVersion: 1, redactPaths: ['secret-repo', 'secret', 'secret-repo'], requiredCalibrationConditions: [] }),
      );

      const diff = await runDiffDiagnosis(repo.path, repo.headSha);

      expect(diff.comparison.compatible).toBe(true);
      expect(diff.comparison.newSignals).toEqual([]);
      expect(diff.comparison.worsenedSignals).toEqual([]);
      expect(diff.comparison.improvedSignals).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not fall back to an older compatible baseline when the newest same-commit entry is incompatible', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const baselineDir = path.join(repo.path, '.r3-doctor', 'baselines');
      await mkdir(baselineDir, { recursive: true });
      await writeFile(
        path.join(baselineDir, 'older-compatible.json'),
        JSON.stringify({
          schemaVersion: 3,
          kind: 'r3-doctor/baseline',
          inputId: 'older-compatible',
          generatedAt: '2026-01-01T00:00:00.000Z',
          assessmentContractVersion: 3,
          sourceCommitSha: repo.baseSha,
          redactionPolicyFingerprint: redactionPolicyFingerprint([]),
          analysisContextFingerprint: snapshot.analysisContextFingerprint,
          report,
        }),
      );
      await writeFile(
        path.join(baselineDir, 'newer-incompatible.json'),
        JSON.stringify({
          schemaVersion: 2,
          inputId: 'newer-incompatible',
          generatedAt: '2026-01-02T00:00:00.000Z',
          assessmentContractVersion: 3,
          sourceCommitSha: repo.baseSha,
          redactionPolicyFingerprint: redactionPolicyFingerprint([]),
          report,
        }),
      );

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('baseline schema mismatch');
      expect(diff.base).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('does not report schema diagnostics from incompatible entries saved for another commit', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const baselineDir = path.join(repo.path, '.r3-doctor', 'baselines');
      await mkdir(baselineDir, { recursive: true });
      await writeFile(
        path.join(baselineDir, 'unrelated-old.json'),
        JSON.stringify({
          schemaVersion: 2,
          inputId: 'unrelated-old',
          generatedAt: '2026-01-02T00:00:00.000Z',
          assessmentContractVersion: 3,
          sourceCommitSha: repo.headSha,
          redactionPolicyFingerprint: redactionPolicyFingerprint([]),
          report,
        }),
      );

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('baseline commit mismatch');
      expect(diff.comparison.reason).not.toContain('baseline schema mismatch');
      expect(diff.base).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a parseable old baseline schema as incompatible instead of absent', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const baselineDir = path.join(repo.path, '.r3-doctor', 'baselines');
      await mkdir(baselineDir, { recursive: true });
      await writeFile(
        path.join(baselineDir, 'old.json'),
        JSON.stringify({
          schemaVersion: 2,
          inputId: report.metadata.inputId,
          generatedAt: report.metadata.generatedAt,
          assessmentContractVersion: report.metadata.assessmentContractVersion,
          sourceCommitSha: repo.baseSha,
          report,
        }),
      );

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('baseline schema mismatch');
      expect(diff.comparison.reason).not.toContain('no stored baseline');
      expect(diff.base).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('reports a parseable old assessment contract as incompatible instead of absent', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const oldContractReport = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
      (oldContractReport.metadata as Record<string, unknown>).assessmentContractVersion = 1;
      const baselineDir = path.join(repo.path, '.r3-doctor', 'baselines');
      await mkdir(baselineDir, { recursive: true });
      await writeFile(
        path.join(baselineDir, 'old-contract.json'),
        JSON.stringify({
          schemaVersion: 3,
          kind: 'r3-doctor/baseline',
          inputId: report.metadata.inputId,
          generatedAt: report.metadata.generatedAt,
          assessmentContractVersion: 1,
          sourceCommitSha: repo.baseSha,
          redactionPolicyFingerprint: 'old-contract-policy',
          analysisContextFingerprint: snapshot.analysisContextFingerprint,
          report: oldContractReport,
        }),
      );

      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);

      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('assessment contract mismatch');
      expect(diff.comparison.reason).not.toContain('no stored baseline');
      expect(diff.base).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('raises ConfigError for malformed baseline JSON', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const baselineDir = path.join(repo.path, '.r3-doctor', 'baselines');
      await mkdir(baselineDir, { recursive: true });
      await writeFile(path.join(baselineDir, 'broken.json'), '{broken');

      await expect(runDiffDiagnosis(repo.path, repo.baseSha)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await repo.cleanup();
    }
  });
});
