import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDiffDiagnosis } from '../../src/commands/diff.js';
import { createRepositorySnapshot, type RepositorySnapshot } from '../../src/intake/snapshot.js';
import { runDiagnosis } from '../../src/pipeline/diagnose.js';
import type { Evidence } from '../../src/schema/report.v1.js';
import * as processPort from '../../src/semantic/acp/process-port.js';
import { prepareSemanticInput, selectLlmCandidateFiles } from '../../src/semantic/provider.js';
import { defaultConfig, defaultLlmConfig } from '../../src/shared/config.js';
import { fakeAcpAgent } from '../helpers/fake-acp-agent.js';
import { createGitRepository } from '../helpers/git-repository.js';

const files = [
  ['src/feature/changed.ts', 'import "../shared/helper.js"; export const changed = 1;'],
  ['src/shared/helper.ts', 'export const helper = 1;'],
  ['src/feature/caller.ts', 'import "./changed.js";'],
  ['src/feature/unrelated.ts', 'export const unrelated = 1;'],
  ['src/other/private.ts', 'export const privateValue = 1;'],
] as const;

function snapshot(sendScope: 'changed' | 'cluster-context'): RepositorySnapshot {
  return {
    repositoryPath: '/repo', inputId: 'scope', gitAvailable: false, gitDirty: false,
    truncated: false, intakeIssues: [], analysisContextFingerprint: '0'.repeat(64),
    config: { ...defaultConfig, llm: { ...defaultLlmConfig, sendScope } },
    files: files.map(([relativePath, content]) => ({
      relativePath, content, absolutePath: `/repo/${relativePath}`, extension: '.ts',
      contentHash: relativePath, nonBlankLines: 1,
    })),
  };
}

const evidence: Evidence[] = [{
  evidenceId: 'evidence:large-file:src/feature/changed.ts', signalId: 'large-file',
  axisId: 'structural-fragility', path: 'src/feature/changed.ts', relatedPaths: [],
  strength: 50, rationale: 'test', pathRole: 'product', severity: 'medium',
  message: 'large file', metrics: { lines: 500 }, source: 'deterministic',
}];

describe('REG-2026-030 semantic send scope', () => {
  afterEach(() => vi.restoreAllMocks());

  it('changed selects actual changed paths independently of evidence', () => {
    const candidates = selectLlmCandidateFiles(snapshot('changed'), evidence, ['src/other/private.ts']);
    expect(candidates.map((file) => file.relativePath)).toEqual(['src/other/private.ts']);
  });

  it('cluster context includes direct graph neighbors and excludes unrelated siblings under src', () => {
    const candidates = selectLlmCandidateFiles(snapshot('cluster-context'), evidence);
    expect(candidates.map((file) => file.relativePath).sort()).toEqual([
      'src/feature/caller.ts', 'src/feature/changed.ts', 'src/shared/helper.ts',
    ]);
  });

  it('scan changed scope retains untracked non-ASCII and leading-space Git paths', async () => {
    const repo = await createGitRepository();
    try {
      await repo.write('src/日本語.ts', 'export const added = 1;');
      await repo.write(' leading.ts', 'export const spaced = 1;');
      const config = { ...defaultLlmConfig, sendScope: 'changed' as const };
      const selected = await prepareSemanticInput(await createRepositorySnapshot(repo.path, undefined, config), []);
      expect(selected.snapshot.files.map((file) => file.relativePath).sort()).toEqual([
        ' leading.ts', 'src/日本語.ts',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it.each(['scan', 'diff'] as const)('%s sends only Git changes and their evidence before ACP is called', async (command) => {
    const repo = await createGitRepository({
      'src/changed.ts': 'export const changed = 1;\n',
      'src/private.ts': 'export const untouchedPrivateValue = 1;\n',
    });
    const agent = fakeAcpAgent({
      initialize: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
      promptChunks: ['[]'],
    });
    vi.spyOn(processPort, 'spawnLlmProcess').mockImplementation((spec) => agent.spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: spec.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    }));
    try {
      await repo.write('src/changed.ts', 'export const changed = 2;\n');
      if (command === 'diff') await repo.commit('change source');
      const config = { ...defaultLlmConfig, enabled: true, provider: 'copilot' as const, sendScope: 'changed' as const };
      if (command === 'scan') {
        await runDiagnosis(await createRepositorySnapshot(repo.path, undefined, config));
      } else {
        await runDiffDiagnosis(repo.path, repo.baseSha, config);
      }
      expect(agent.promptRequests).toHaveLength(1);
      const prompt = JSON.stringify(agent.promptRequests[0]?.prompt);
      expect(prompt).toContain('File: src/changed.ts');
      expect(prompt).not.toContain('src/private.ts');
      expect(prompt).not.toContain('untouchedPrivateValue');
    } finally {
      await repo.cleanup();
    }
  });

  it('changed sends no source or repository evidence when Git is unavailable', async () => {
    const selected: Array<{ paths: string[]; evidence: Evidence[] }> = [];
    const input = snapshot('changed');
    input.config.llm = { ...input.config.llm, enabled: true, provider: 'copilot' };
    await runDiagnosis(input, {
      skipCalibrationResolution: true,
      semanticProviderFactory: { create: () => ({ status: 'available', provider: {
        name: 'test', implementationVersion: '1',
        analyze: async (scope, items) => {
          selected.push({ paths: scope.files.map((file) => file.relativePath), evidence: items });
          return [];
        },
      } }) },
    });
    expect(selected).toEqual([{ paths: [], evidence: [] }]);
  });
});
