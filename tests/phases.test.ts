import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GoStubAnalyzerPlugin,
  PythonStubAnalyzerPlugin,
  TypeScriptAnalyzerPlugin,
  negotiateCapabilities,
} from '../src/plugins/analyzer.js';
import { loadCalibration } from '../src/calibration/dataset.js';
import { deriveGateEligible, evaluatePolicy, policySchema } from '../src/operations/policy.js';
import type { RepositorySnapshot } from '../src/intake/snapshot.js';
import { DefaultSemanticProviderFactory, runSemanticAnalysis } from '../src/semantic/provider.js';

const root = path.dirname(fileURLToPath(import.meta.url));

const emptySnapshot: RepositorySnapshot = {
  repositoryPath: root,
  files: [
    {
      relativePath: 'src/a.ts',
      absolutePath: path.join(root, 'src/a.ts'),
      extension: '.ts',
      content: '',
      contentHash: 'abc',
      nonBlankLines: 1,
    },
  ],
  inputId: 'test',
  gitAvailable: false,
  gitDirty: false,
  analysisContextFingerprint: '0'.repeat(64),
  truncated: false,
  intakeIssues: [],
  config: { schemaVersion: 1 } as never,
};

describe('phase 4-6 capabilities', () => {
  it('requires each policy-defined calibration condition for gate eligibility', () => {
    const qualityInput = {
      calibrationPresent: true,
      minSamplesPerBand: true,
      hasFalsePositiveRate: true,
      hasMissRate: true,
      hasRankingQuality: true,
      hasExplanationUsefulness: true,
      goldenRegressionPassed: true,
    };

    expect(deriveGateEligible(qualityInput, ['security-reviewed'], [])).toBe(false);
    expect(deriveGateEligible(qualityInput, ['security-reviewed'], ['security-reviewed'])).toBe(true);
  });

  it('marks git churn unevaluated when a TypeScript snapshot has no Git history', () => {
    const plugins = [new TypeScriptAnalyzerPlugin(), new PythonStubAnalyzerPlugin(), new GoStubAnalyzerPlugin()];
    const negotiation = negotiateCapabilities(emptySnapshot, plugins);
    expect(negotiation.supported).toContain('dep-cycle');
    expect(negotiation.unevaluated).toContain('git-churn');
    expect(negotiation.capabilities[0]?.supportedSignals).not.toContain('git-churn');
    expect(negotiation.capabilities[0]?.unevaluatedSignals).toContain('git-churn');
  });

  it('returns available for a configured codex provider', () => {
    const resolution = new DefaultSemanticProviderFactory().create({
      enabled: true,
      provider: 'codex',
      maxFiles: 1,
      sendScope: 'all',
      maxPromptBytes: 80_000,
    });
    expect(resolution.status).toBe('available');
    if (resolution.status === 'available') {
      expect(resolution.provider.name).toBe('codex');
    }
  });

  it('normalizes openai alias to codex in the factory', () => {
    const resolution = new DefaultSemanticProviderFactory().create({
      enabled: true,
      provider: 'openai' as never,
      maxFiles: 1,
      sendScope: 'all',
      maxPromptBytes: 80_000,
    });
    expect(resolution.status).toBe('available');
    if (resolution.status === 'available') {
      expect(resolution.provider.name).toBe('codex');
    }
  });

  it('returns findings from the actual provider supplied by an injected semantic factory', async () => {
    const provider = {
      name: 'injected',
      implementationVersion: '1.0.0',
      analyze: async () => [
        {
          axisId: 'semantic-ambiguity' as const,
          path: 'src/a.ts',
          summary: 'Injected provider finding',
          relatedEvidenceIds: [],
          confidence: 0.8,
        },
      ],
    };
    const result = await runSemanticAnalysis(
      {
        ...emptySnapshot,
        config: { schemaVersion: 1, llm: { enabled: true, provider: 'openai', maxFiles: 1, sendScope: 'all' } } as never,
      },
      [],
      { create: () => ({ status: 'available', provider }) },
    );

    expect(result.resolution).toEqual({ status: 'available', provider });
    expect(result.findings).toEqual([
      {
        findingId: 'finding:semantic:1',
        axisId: 'semantic-ambiguity',
        path: 'src/a.ts',
        summary: 'Injected provider finding',
        relatedEvidenceIds: [],
        confidence: 0.8,
        impactScope: 'module',
      },
    ]);
  });

  it('loads calibration dataset with gate conditions', async () => {
    const dataset = await loadCalibration(root, false, []);
    expect(dataset.gateEligible).toBe(false);
    expect(dataset.gateConditions.length).toBeGreaterThan(0);
  });

  it('does not auto-fail gate when calibration missing', () => {
    const policy = policySchema.parse({ schemaVersion: 1, gateEnabled: true, requiredCalibrationConditions: [] });
    const evaluation = evaluatePolicy(90, 0.8, policy, false, []);
    expect(evaluation.gateWouldFail).toBe(false);
    expect(evaluation.reasons.some((r) => r.includes('calibration'))).toBe(true);
  });

  it('suppresses gate on low confidence', () => {
    const policy = policySchema.parse({
      schemaVersion: 1,
      gateEnabled: true,
      requireCalibration: false,
      requiredCalibrationConditions: [],
    });
    const evaluation = evaluatePolicy(90, 0.3, policy, true, []);
    expect(evaluation.gateWouldFail).toBe(false);
  });
});
