import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDiffDiagnosis } from '../src/commands/diff.js';
import { createRepositorySnapshot, computeInputId, type RepositorySnapshot } from '../src/intake/snapshot.js';
import { saveBaseline } from '../src/persistence/baseline-store.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { createGitRepository } from './helpers/git-repository.js';

// Reproduce the stored context shape before shared source byte limits were introduced.
function legacyIntakeFingerprint(snapshot: RepositorySnapshot): string {
  const { config } = snapshot;
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    assessmentContractVersion: 4,
    scope: { unitId: null, roots: ['.'], exclude: [...new Set(config.exclude)].sort() },
    limits: {
      maxFiles: config.maxFiles,
      maxFileLines: config.maxFileLines,
      fanOutThreshold: config.fanOutThreshold,
      fanInThreshold: config.fanInThreshold,
      churnDays: config.churnDays,
    },
    llm: { ...config.llm },
    gitAvailable: true,
  })).digest('hex');
}

describe('REG-2026-029 shared intake baseline compatibility', () => {
  it.each([
    ['Python', '.py', 'value = 1\n'],
    ['Go', '.go', 'package main\n'],
  ])('suppresses false improvement when bounded intake omits unchanged large %s source', async (_language, extension, line) => {
    const relativePath = `oversized${extension}`;
    const content = line.repeat(Math.ceil(1_048_577 / line.length));
    const repository = await createGitRepository({
      [relativePath]: content,
      [`ordinary${extension}`]: line,
    });
    try {
      const bounded = await createRepositorySnapshot(repository.path);
      expect(bounded.files.map((file) => file.relativePath)).toEqual([`ordinary${extension}`]);
      expect(bounded.intakeIssues).toContainEqual({
        kind: 'unreadable-file', path: relativePath, message: 'source file exceeds 1048576 byte limit',
      });
      const legacyFiles = [...bounded.files, {
        relativePath, absolutePath: path.join(repository.path, relativePath), extension,
        content, contentHash: createHash('sha256').update(content).digest('hex'),
        nonBlankLines: content.split('\n').filter(Boolean).length,
      }];
      const legacy: RepositorySnapshot = {
        ...bounded,
        files: legacyFiles,
        intakeIssues: [],
        inputId: computeInputId(undefined, legacyFiles, bounded.config),
        analysisContextFingerprint: legacyIntakeFingerprint(bounded),
      };
      const baseline = await runDiagnosis(legacy);
      expect(baseline.evidence.some((item) => item.signalId === 'large-file' && item.path === relativePath)).toBe(true);
      expect(baseline.repository.regressionRiskScore).toBeGreaterThan(0);
      await saveBaseline(legacy, baseline);

      const diff = await runDiffDiagnosis(repository.path, repository.headSha);

      expect(diff.current.metadata.assessmentContractVersion).toBe(4);
      expect(diff.current.repository.regressionRiskScore).toBe(0);
      expect(diff.current.capabilities).toEqual(baseline.capabilities);
      expect(diff.comparison.changedFiles).toEqual([]);
      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('analysis context mismatch');
      expect(diff.comparison.improvedSignals).toEqual([]);
      expect(diff.comparison.riskDelta).toBeUndefined();
      expect(diff.base).toBeUndefined();
    } finally {
      await repository.cleanup();
    }
  });
});
