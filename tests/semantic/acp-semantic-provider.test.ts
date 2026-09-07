import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RepositorySnapshot } from '../../src/intake/snapshot.js';
import { AcpSemanticProvider } from '../../src/semantic/providers/acp-semantic-provider.js';
import { buildBudgetedSemanticPrompt } from '../../src/semantic/semantic-prompt.js';

describe('AcpSemanticProvider prompt budget', () => {
  it('REG-2026-008 does not spawn a provider when the completed prompt exceeds maxPromptBytes', async () => {
    let spawnCount = 0;
    const repositoryPath = '/tmp/r3-doctor-prompt-budget';
    const snapshot = {
      repositoryPath,
      files: [{
        relativePath: 'src/a.ts',
        absolutePath: path.join(repositoryPath, 'src/a.ts'),
        extension: '.ts',
        content: 'export const a = 1;\n',
        contentHash: 'a',
        nonBlankLines: 1,
      }],
      inputId: 'prompt-budget',
      gitAvailable: false,
      gitDirty: false,
      analysisContextFingerprint: '0'.repeat(64),
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as RepositorySnapshot;
    const provider = new AcpSemanticProvider(
      'codex',
      { enabled: true, provider: 'codex', maxFiles: 1, sendScope: 'all', maxPromptBytes: 100 },
      () => {
        spawnCount += 1;
        throw new Error('provider must not be spawned');
      },
    );

    await expect(provider.analyze(snapshot, [])).rejects.toThrow(/maxPromptBytes 100/);
    expect(spawnCount).toBe(0);
  });

  it('keeps instructions, evidence, and selected source within the completed prompt budget', () => {
    const repositoryPath = '/tmp/r3-doctor-prompt-budget';
    const snapshot = {
      repositoryPath,
      files: [{
        relativePath: 'src/a.ts',
        absolutePath: path.join(repositoryPath, 'src/a.ts'),
        extension: '.ts',
        content: 'export const a = 1;\n',
        contentHash: 'a',
        nonBlankLines: 1,
      }],
      inputId: 'prompt-budget',
      gitAvailable: false,
      gitDirty: false,
      analysisContextFingerprint: '0'.repeat(64),
      truncated: false,
      intakeIssues: [],
      config: { schemaVersion: 1 },
    } as RepositorySnapshot;
    const maxPromptBytes = 2_000;

    const { prompt } = buildBudgetedSemanticPrompt(snapshot, [], maxPromptBytes);

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(maxPromptBytes);
    expect(prompt).toContain('File: src/a.ts');
    expect(prompt).toContain('export const a = 1;');
  });
});
