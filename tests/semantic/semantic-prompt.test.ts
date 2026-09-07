import { describe, expect, it } from 'vitest';

import type { RepositorySnapshot } from '../../src/intake/snapshot.js';
import type { Evidence } from '../../src/schema/report.v1.js';
import { buildBudgetedSemanticPrompt } from '../../src/semantic/semantic-prompt.js';
import { SEMANTIC_PROVIDER_IMPL_VERSION } from '../../src/semantic/providers/acp-semantic-provider.js';
import { defaultConfig } from '../../src/shared/config.js';

const snapshot: RepositorySnapshot = {
  repositoryPath: '/Users/alice/private-repository',
  inputId: 'input',
  files: [{
    relativePath: 'src/large.ts',
    absolutePath: '/Users/alice/private-repository/src/large.ts',
    extension: '.ts',
    content: 'export const value = 1;\n'.repeat(500),
    contentHash: 'hash',
    nonBlankLines: 500,
  }],
  gitAvailable: false,
  gitDirty: false,
  analysisContextFingerprint: '0'.repeat(64),
  truncated: false,
  intakeIssues: [],
  config: defaultConfig,
};

const evidence: Evidence[] = [{
  evidenceId: 'evidence:large-file:src/large.ts',
  signalId: 'large-file',
  axisId: 'structural-fragility',
  path: 'src/large.ts',
  severity: 'medium',
  message: 'large source file',
  source: 'deterministic',
}];

describe('semantic prompt boundary', () => {
  it('REG-2026-018 caps the fully serialized prompt and omits absolute paths', () => {
    const result = buildBudgetedSemanticPrompt(snapshot, evidence, 2_048);

    expect(Buffer.byteLength(result.prompt, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(result.prompt).not.toContain(snapshot.repositoryPath);
    expect(result.prompt).toContain('Repository: [REPOSITORY]');
    expect(result.prompt.match(/evidence:large-file:src\/large\.ts/g)).toHaveLength(1);
    expect(result.omittedFileCount).toBe(1);
  });

  it('rejects a budget smaller than the fixed prompt contract', () => {
    expect(() => buildBudgetedSemanticPrompt(snapshot, evidence, 1)).toThrow(
      'fixed content exceeds 1 byte limit',
    );
  });

  it('publishes a new provider implementation identity for the prompt contract', () => {
    expect(SEMANTIC_PROVIDER_IMPL_VERSION).toBe('2.1.0');
  });

  it('requires impactScope and keeps confidence separate from risk magnitude', () => {
    const result = buildBudgetedSemanticPrompt(snapshot, evidence, 2_048);

    expect(result.prompt).toContain('"impactScope":"local"');
    expect(result.prompt).toContain('confidence measures finding certainty only');
    expect(result.prompt).toContain('impactScope must be one of local, module, or repository');
  });
});
