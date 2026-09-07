import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { writeGitHubAnnotationsFile, writeGitHubSummaryFile } from '../src/reporting/github.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  DIFF_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  diffReportSchema,
  provisionalEvidenceDetails,
} from '../src/schema/report.v1.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { loadBaseline, saveBaseline } from '../src/persistence/baseline-store.js';
import { appendTrend, loadTrendHistory } from '../src/persistence/trend-store.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { runDiffDiagnosis } from '../src/commands/diff.js';
import { DefaultSemanticProviderFactory } from '../src/semantic/provider.js';
import { fakeAcpAgent } from './helpers/fake-acp-agent.js';
import * as acp from '@agentclientprotocol/sdk';
import {
  formatConsoleReport,
  formatDiffConsoleReport,
  formatDiffMarkdownReport,
  formatJsonReport,
  formatMarkdownReport,
} from '../src/reporting/format.js';
import { baselineEntrySchema } from '../src/schema/report.v1.js';
import { createGitRepository } from './helpers/git-repository.js';
import type { AnalyzerPlugin } from '../src/plugins/analyzer.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(root, 'fixtures');
const repoRoot = path.join(root, '..');
const execFileAsync = promisify(execFile);

function runCli(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const cliPath = path.join(repoRoot, 'src', 'cli.ts');
  const tsxPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return execFileAsync(process.execPath, [tsxPath, cliPath, ...args], {
    cwd: options.cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runCliWithPipedStdout(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const cliPath = path.join(repoRoot, 'src', 'cli.ts');
  const tsxPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
      });
    });
  });
}

type ScanReport = {
  metadata: { inputId: string; reportLocale?: string };
  repository: { regressionRiskScore: number; confidence: number; disclaimer: string };
  evidence: Array<{ evidenceId: string; metrics?: Record<string, unknown> }>;
};

function minimalV4Repository(overrides: Record<string, unknown> = {}) {
  return {
    regressionRiskScore: 10,
    confidence: 1,
    disclaimer: 'd',
    scoreBreakdown: { axisBase: 10, criticalClusterUplift: 0 },
    confidenceBreakdown: {
      signalCoverage: 1,
      semanticAnalysis: 0,
      gitHistory: 1,
      inputCompleteness: 1,
    },
    calibration: { status: 'uncalibrated' },
    ...overrides,
  };
}

function minimalV4Metadata(inputId: string) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputId,
    repositoryPath: '/tmp',
    analyzers: [],
    truncated: false,
    unevaluatedAreas: [],
  };
}

function sampleV4Evidence(overrides: Record<string, unknown> = {}) {
  const details = provisionalEvidenceDetails('high', 'src/a.ts');
  return {
    evidenceId: 'evidence:dep-cycle:src/a.ts',
    signalId: 'dep-cycle',
    axisId: 'structural-fragility',
    path: 'src/a.ts',
    severity: 'high',
    message: 'cycle detected',
    source: 'deterministic',
    ...details,
    ...overrides,
  };
}

function minimalV4Report(inputId: string) {
  return {
    metadata: minimalV4Metadata(inputId),
    repository: minimalV4Repository(),
    axes: [],
    clusters: [],
    evidence: [],
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

describe('integration: multi-language scan', () => {
  it('negotiates capabilities per detected language', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'mixed-lang'));
    const report = await runDiagnosis(snapshot);
    const languages = report.capabilities.map((entry) => entry.language).sort();
    expect(languages).toEqual(['go', 'python', 'typescript-javascript']);
    expect(report.capabilities.find((entry) => entry.language === 'python')?.completeness).toBe('partial');
    expect(report.capabilities.find((entry) => entry.language === 'go')?.unevaluatedSignals.length).toBeGreaterThan(0);
  });
});

describe('integration: semantic unevaluated', () => {
  it('marks semantic ambiguity unevaluated when LLM is disabled', async () => {
    const report = await runDiagnosis(await createRepositorySnapshot(path.join(fixturesRoot, 'stable-cart')));
    const semanticAxis = report.axes.find((axis) => axis.axisId === 'semantic-ambiguity');
    expect(semanticAxis?.unevaluated).toBe(true);
    expect(report.metadata.semanticProviderStatus).toBe('not-configured');
    expect(report.metadata.unevaluatedAreas.some((area) => area.includes('Semantic Ambiguity') || area === 'Semantic Ambiguity')).toBe(true);
  });
});

describe('integration: semantic provider injection', () => {
  it('routes an injected semantic provider through runDiagnosis', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-semantic-pipeline-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(repositoryPath, 'r3-doctor.config.json'), JSON.stringify({ schemaVersion: 1 }));
      const snapshot = await createRepositorySnapshot(repositoryPath, undefined, {
        enabled: true,
        provider: 'codex',
        maxFiles: 1,
        sendScope: 'all',
        maxPromptBytes: 80_000,
      });
      let analyzed = false;

      const report = await runDiagnosis(snapshot, {
        semanticProviderFactory: {
          create: () => ({
            status: 'available' as const,
            provider: {
              name: 'injected',
              implementationVersion: '1.0.0',
              analyze: async () => {
                analyzed = true;
                return [{
                  findingId: 'finding:semantic:injected',
                  axisId: 'semantic-ambiguity' as const,
                  path: 'src/a.ts',
                  summary: 'Injected provider reached the diagnosis pipeline',
                  relatedEvidenceIds: [],
                  confidence: 0.9,
                }];
              },
            },
          }),
        },
      });

      expect(analyzed).toBe(true);
      expect(report.metadata.semanticProviderStatus).toBe('available');
      expect(report.semanticFindings.map((finding) => finding.findingId)).toContain('finding:semantic:injected');
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: CLI-owned semantic policy', () => {
  it('accepts semantic scope limits for a dry run without enabling an external provider', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-semantic-cli-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const ambiguous = 1;\n');
      const cliPath = path.join(root, '..', 'src', 'cli.ts');
      const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

      const result = await execFileAsync(process.execPath, [
        tsxPath,
        cliPath,
        'scan',
        repositoryPath,
        '--dry-run-semantic',
        '--llm-send-scope',
        'all',
        '--llm-max-files',
        '1',
      ]);

      expect(result.stdout).toContain('src/a.ts');
      expect(result.stdout).not.toContain(repositoryPath);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('rejects executable overrides unless a provider is explicitly enabled', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-semantic-cli-'));
    try {
      const cliPath = path.join(root, '..', 'src', 'cli.ts');
      const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const error = await execFileAsync(process.execPath, [
        tsxPath,
        cliPath,
        'scan',
        repositoryPath,
        '--llm-executable',
        '/usr/bin/true',
      ]).catch((caught: unknown) => caught as { stderr: string });

      expect(error.stderr).toContain('--llm-executable requires --llm-provider');
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: ACP semantic provider', () => {
  it('evaluates semantic ambiguity through the default factory with fake ACP spawn', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-acp-semantic-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const ambiguous = 1;\n');
      await writeFile(path.join(repositoryPath, 'r3-doctor.config.json'), JSON.stringify({ schemaVersion: 1 }));

      const script = fakeAcpAgent({
        initialize: {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {},
          authMethods: [],
        },
        promptChunks: [
          '[{"axisId":"semantic-ambiguity","path":"src/a.ts","summary":"Naming is ambiguous","relatedEvidenceIds":[],"confidence":0.7}]',
        ],
      });

      const snapshot = await createRepositorySnapshot(repositoryPath, undefined, {
        enabled: true,
        provider: 'copilot',
        maxFiles: 5,
        sendScope: 'all',
        maxPromptBytes: 80_000,
      });
      const report = await runDiagnosis(snapshot, {
        semanticProviderFactory: new DefaultSemanticProviderFactory(script.spawn),
      });

      expect(report.metadata.semanticProviderStatus).toBe('available');
      expect(report.semanticFindings.some((finding) => finding.summary.includes('ambiguous'))).toBe(true);
      expect(report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')?.unevaluated).toBe(false);
      expect(JSON.stringify(script.promptRequests)).not.toContain(repositoryPath);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: Git-dependent capability unevaluated', () => {
  it('marks change volatility unevaluated for a non-Git repository snapshot', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'stable-cart'));
    snapshot.gitAvailable = false;
    const report = await runDiagnosis(snapshot);

    expect(report.capabilities.find((entry) => entry.language === 'typescript-javascript')?.supportedSignals).not.toContain('git-churn');
    expect(report.axes.find((axis) => axis.axisId === 'change-volatility')?.unevaluated).toBe(true);
  });

  it('does not import churn evidence from outside the analyzed unit scope', async () => {
    const repo = await createGitRepository({
      'r3-doctor.config.json': JSON.stringify({
        schemaVersion: 1,
        churnDays: 3650,
        units: [{ id: 'app', roots: ['packages/app'] }],
      }),
      'packages/app/a.ts': 'export const a = 1;\n',
      'packages/noisy/noisy.ts': 'export const noisy = 0;\n',
    });
    try {
      for (let index = 1; index <= 6; index += 1) {
        await repo.write('packages/noisy/noisy.ts', `export const noisy = ${index};\n`);
        await repo.commit(`change unrelated file ${index}`);
      }

      const snapshot = await createRepositorySnapshot(repo.path, 'app');
      const report = await runDiagnosis(snapshot);

      expect(snapshot.gitAvailable).toBe(true);
      expect(report.evidence.filter((item) => item.signalId === 'git-churn')).toEqual([]);
      expect(report.evidence.some((item) => item.path?.startsWith('packages/noisy/'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps a stable fixture score independent of parent repository history', async () => {
    const repo = await createGitRepository({
      'fixtures/stable/src/a.ts': 'export const a = 1;\n',
      'fixtures/stable/src/__tests__/a.test.ts': 'export const tested = true;\n',
    });
    const standalonePath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-standalone-fixture-'));
    try {
      const fixturePath = path.join(repo.path, 'fixtures', 'stable');
      await mkdir(path.join(standalonePath, 'src', '__tests__'), { recursive: true });
      await writeFile(path.join(standalonePath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(
        path.join(standalonePath, 'src', '__tests__', 'a.test.ts'),
        'export const tested = true;\n',
      );
      const nestedSnapshot = await createRepositorySnapshot(fixturePath);
      const nestedReport = await runDiagnosis(nestedSnapshot);
      const standaloneReport = await runDiagnosis(await createRepositorySnapshot(standalonePath));

      expect(nestedSnapshot.gitAvailable).toBe(false);
      expect(nestedReport.evidence.some((item) => item.signalId === 'git-churn')).toBe(false);
      expect(nestedReport.repository.regressionRiskScore).toBe(standaloneReport.repository.regressionRiskScore);
    } finally {
      await rm(standalonePath, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it('does not use parent Git history when diffing a nested non-Git analysis root', async () => {
    const repo = await createGitRepository({
      'fixtures/stable/src/a.ts': 'export const a = 1;\n',
      'outside.ts': 'export const outside = 1;\n',
    });
    try {
      await repo.write('outside.ts', 'export const outside = 2;\n');
      await repo.commit('change only outside nested analysis root');
      const fixturePath = path.join(repo.path, 'fixtures', 'stable');

      const diff = await runDiffDiagnosis(fixturePath, repo.baseSha);

      expect(diff.current.metadata.repositoryPath).toBe('[REPOSITORY]');
      expect(diff.comparison.compatible).toBe(false);
      expect(diff.comparison.reason).toContain('Git unavailable for analyzed root');
      expect(diff.comparison.changedFiles).toEqual([]);
      expect(diff.comparison.blastRadius).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it('retains unsupported churn evidence for audit without recommending from it', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-capability-pipeline-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      const snapshot = await createRepositorySnapshot(repositoryPath);
      const plugin: AnalyzerPlugin = {
        id: 'unsupported-churn-test',
        implementationVersion: '1.0.0',
        extensions: ['.ts'],
        capabilities: [{
          language: 'typescript-javascript',
          contractVersion: 4,
          signals: ['git-churn'],
          completeness: 'partial',
        }],
        extract: async () => {
          const details = provisionalEvidenceDetails('high', 'src/a.ts');
          return [{
            evidenceId: 'evidence:git-churn:src/a.ts',
            signalId: 'git-churn',
            axisId: 'change-volatility',
            path: 'src/a.ts',
            severity: 'high',
            message: 'unsupported churn evidence retained for audit',
            source: 'deterministic',
            ...details,
          }];
        },
      };

      const report = await runDiagnosis(snapshot, { analyzerPlugins: [plugin] });

      expect(report.evidence.map((item) => item.signalId)).toContain('git-churn');
      expect(report.axes.find((axis) => axis.axisId === 'change-volatility')).toMatchObject({
        unevaluated: true,
        score: 0,
      });
      expect(report.clusters.some((cluster) => cluster.axisId === 'change-volatility')).toBe(false);
      expect(report.interventions.some((item) => item.linkedSignalIds.includes('git-churn'))).toBe(false);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: calibration status in diagnosis', () => {
  it('reports uncalibrated when calibration file is absent', async () => {
    const report = await runDiagnosis(await createRepositorySnapshot(path.join(fixturesRoot, 'stable-cart')));
    expect(report.repository.calibration.status).toBe('uncalibrated');
  });

  it('reports provisional when calibration dataset is incomplete', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-calibration-status-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(repositoryPath, 'r3-doctor.config.json'), JSON.stringify({ schemaVersion: 1 }));
      await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
      await writeFile(path.join(repositoryPath, '.r3-doctor', 'calibration.json'), JSON.stringify({
        schemaVersion: 1,
        records: [{
          schemaVersion: 1,
          scoreBand: '0-30',
          sampleCount: 12,
          observedRegressions: 1,
          observedReverts: 0,
          falsePositiveRate: 0.1,
          missRate: 0.1,
          rankingQuality: 0.8,
          explanationUsefulness: 0.8,
        }],
        gateConditions: [],
        satisfiedConditions: [],
      }));

      const report = await runDiagnosis(await createRepositorySnapshot(repositoryPath));
      expect(report.repository.calibration.status).toBe('provisional');
      expect(report.repository.calibration.missingConditions?.length).toBeGreaterThan(0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('does not rewrite regression risk score from calibration data', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-calibration-score-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(repositoryPath, 'r3-doctor.config.json'), JSON.stringify({ schemaVersion: 1 }));

      const withoutCalibration = await runDiagnosis(await createRepositorySnapshot(repositoryPath));
      await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
      await writeFile(path.join(repositoryPath, '.r3-doctor', 'calibration.json'), JSON.stringify({
        schemaVersion: 1,
        records: [{
          schemaVersion: 1,
          scoreBand: '0-30',
          sampleCount: 12,
          observedRegressions: 1,
          observedReverts: 0,
          falsePositiveRate: 0.1,
          missRate: 0.1,
          rankingQuality: 0.8,
          explanationUsefulness: 0.8,
        }],
        gateConditions: [],
        satisfiedConditions: [],
      }));

      const withCalibration = await runDiagnosis(await createRepositorySnapshot(repositoryPath));
      expect(withCalibration.repository.regressionRiskScore).toBe(withoutCalibration.repository.regressionRiskScore);
      expect(withCalibration.repository.calibration.status).toBe('provisional');
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: output evidence traceability', () => {
  it('includes evidence details in console, markdown, and json outputs', async () => {
    const report = await runDiagnosis(await createRepositorySnapshot(path.join(fixturesRoot, 'fragile-cart')));
    const consoleOut = formatConsoleReport(report, { view: 'all' });
    const markdownOut = formatMarkdownReport(report, { view: 'all' });
    const jsonOut = formatJsonReport(report);

    expect(consoleOut).toContain('mechanism:');
    expect(consoleOut).toContain('Grouped evidence');
    expect(consoleOut).toContain('Improvement points');
    expect(markdownOut).toContain('## Current state');
    expect(markdownOut).toContain('### Grouped evidence');
    expect(markdownOut).toContain('## Improvement points');
    expect(jsonOut).toContain('"evidenceId"');
    expect(jsonOut).toContain('"capabilities"');
  });
});

describe('integration: CLI report views', () => {
  it('defaults to all view and keeps json full when view is facts', async () => {
    const repositoryPath = path.join(fixturesRoot, 'fragile-cart');
    const cliPath = path.join(root, '..', 'src', 'cli.ts');
    const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

    const markdown = await execFileAsync(process.execPath, [
      tsxPath,
      cliPath,
      'scan',
      repositoryPath,
      '--format',
      'markdown',
    ]);
    expect(markdown.stdout).toContain('## Diagnosis summary');
    expect(markdown.stdout).toContain('## Improvement points');
    expect(markdown.stdout).toContain('## Current state');

    const factsJson = await execFileAsync(process.execPath, [
      tsxPath,
      cliPath,
      'scan',
      repositoryPath,
      '--format',
      'json',
      '--view',
      'facts',
    ]);
    const parsed = JSON.parse(factsJson.stdout) as { evidence: unknown[] };
    expect(parsed.evidence.length).toBeGreaterThan(0);
  });

  it('rejects unknown view values at parse time', async () => {
    const repositoryPath = path.join(fixturesRoot, 'fragile-cart');
    const cliPath = path.join(root, '..', 'src', 'cli.ts');
    const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const error = await execFileAsync(process.execPath, [
      tsxPath,
      cliPath,
      'scan',
      repositoryPath,
      '--view',
      'verbose',
    ]).catch((caught: unknown) => caught as { stderr: string });

    expect(error.stderr).toContain('expected one of: facts, summary, actions, all');
  });
});

describe('integration: baseline atomic round-trip', () => {
  it('persists and reloads a schema-valid baseline entry', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const baseline = await saveBaseline(snapshot, report);
      const raw = await readFile(baseline.path, 'utf8');
      const entry = baselineEntrySchema.parse(JSON.parse(raw));
      const loaded = await loadBaseline(snapshot, repo.headSha);
      expect(entry.sourceCommitSha).toBe(repo.headSha);
      expect(entry.report.metadata.repositoryPath).toBe('[REPOSITORY]');
      expect(raw).not.toContain(repo.path);
      expect(loaded.entry?.inputId).toBe(entry.inputId);
      expect(loaded.entry?.report.metadata.inputId).toBe(report.metadata.inputId);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('integration: trend corrupt line errors', () => {
  it('reports line number when trend history is corrupt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-trend-'));
    const trendDir = path.join(dir, '.r3-doctor', 'trends');
    await mkdir(trendDir, { recursive: true });
    const trendPath = path.join(trendDir, 'history.jsonl');
    await writeFile(
      trendPath,
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'a',
        score: 1,
        confidence: 1,
        contractVersion: 4,
        topClusters: [],
      })}\n{broken\n`,
    );
    await expect(loadTrendHistory(trendPath)).rejects.toThrow(/line 2/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('integration: trend persistence boundary', () => {
  it('returns the owned trend path and structured retention audit', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      const trendPath = path.join(await realpath(repo.path), '.r3-doctor', 'trends', 'history.jsonl');
      await mkdir(path.dirname(trendPath), { recursive: true });
      await writeFile(trendPath, `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'expired',
        score: 1,
        confidence: 1,
        contractVersion: 4,
        topClusters: [],
      })}\n`);

      const result = await appendTrend(snapshot, report);

      expect(result.path).toBe(trendPath);
      expect(result.retention).toEqual(expect.arrayContaining([
        { storage: 'trend', reason: 'expired', removedEntries: 1 },
      ]));
      expect((await loadTrendHistory(result.path)).map((entry) => entry.inputId)).toEqual([
        report.metadata.inputId,
      ]);
      expect((await loadTrendHistory(result.path))[0]?.commitSha).toBe(snapshot.sourceCommitSha);
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-007 rejects a trend write after HEAD advances beyond the diagnosed snapshot', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      await repo.write('src/a.ts', 'export const a = 2;\n');
      await repo.commit('advance head after diagnosis');

      await expect(appendTrend(snapshot, report)).rejects.toThrow(/Git HEAD changed after repository intake/);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a trend write after the worktree changes beyond the diagnosed snapshot', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);
      await repo.write('src/a.ts', 'export const a = 2;\n');

      await expect(appendTrend(snapshot, report)).rejects.toThrow(/Git worktree state changed after repository intake/);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects a diagnosis report from another snapshot', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const report = await runDiagnosis(snapshot);

      await expect(appendTrend(snapshot, {
        ...report,
        metadata: { ...report.metadata, inputId: 'different-input' },
      })).rejects.toThrow(/diagnosis report does not match the repository snapshot/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('integration: CLI retention audits', () => {
  it('formats every persistence audit to stderr', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const storageRoot = path.join(repo.path, '.r3-doctor');
      const trendDir = path.join(storageRoot, 'trends');
      const snapshot = await createRepositorySnapshot(repo.path);
      const seededBaseline = await saveBaseline(snapshot, await runDiagnosis(snapshot));
      await mkdir(trendDir, { recursive: true });
      await utimes(seededBaseline.path, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
      await writeFile(path.join(trendDir, 'history.jsonl'), `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'expired',
        score: 1,
        confidence: 1,
        contractVersion: 4,
        topClusters: [],
      })}\n`);

      const cliPath = path.join(root, '..', 'src', 'cli.ts');
      const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const { stderr } = await execFileAsync(process.execPath, [
        tsxPath,
        cliPath,
        'scan',
        repo.path,
        '--format',
        'json',
        '--save-baseline',
        '--record-trend',
      ]);
      const auditLines = stderr.trim().split('\n').filter((line) => line.startsWith('retention '));

      expect(auditLines).toEqual([
        'retention storage=baseline reason=expired removed=1',
        'retention storage=trend reason=expired removed=1',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('formats the baseline save audit to stderr', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const snapshot = await createRepositorySnapshot(repo.path);
      const seededBaseline = await saveBaseline(snapshot, await runDiagnosis(snapshot));
      await utimes(seededBaseline.path, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

      const cliPath = path.join(root, '..', 'src', 'cli.ts');
      const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const { stderr } = await execFileAsync(process.execPath, [
        tsxPath,
        cliPath,
        'baseline',
        repo.path,
        '--save',
      ]);

      expect(stderr).toBe('retention storage=baseline reason=expired removed=1\n');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('integration: CLI calibration conditions', () => {
  it('displays missing custom conditions in calibration and policy output', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-calibration-cli-'));
    try {
      await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(repositoryPath, '.r3-doctor', 'policy.json'), JSON.stringify({
        schemaVersion: 1,
        gateEnabled: true,
        requiredCalibrationConditions: ['security-reviewed'],
      }));
      await writeFile(path.join(repositoryPath, '.r3-doctor', 'calibration.json'), JSON.stringify({
        schemaVersion: 1,
        records: [{
          schemaVersion: 1,
          scoreBand: '0-30',
          sampleCount: 30,
          observedRegressions: 1,
          observedReverts: 0,
          falsePositiveRate: 0.1,
          missRate: 0.1,
          rankingQuality: 0.8,
          explanationUsefulness: 0.8,
        }],
        gateConditions: [],
        satisfiedConditions: [],
      }));
      const cliPath = path.join(root, '..', 'src', 'cli.ts');
      const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

      const calibration = await execFileAsync(process.execPath, [tsxPath, cliPath, 'calibration', repositoryPath]);
      const policy = await execFileAsync(process.execPath, [tsxPath, cliPath, 'policy', repositoryPath, '--evaluate']);

      expect(calibration.stdout).toContain('Missing required conditions:\n  - security-reviewed');
      expect(JSON.parse(policy.stdout).missingCalibrationConditions).toEqual(['security-reviewed']);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('integration: plugin catalog', () => {
  it('REG-2026-010 lists declared capabilities for every registered plugin', async () => {
    const cliPath = path.join(root, '..', 'src', 'cli.ts');
    const tsxPath = path.join(root, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

    const { stdout } = await execFileAsync(process.execPath, [tsxPath, cliPath, 'plugins']);
    const catalog = JSON.parse(stdout) as {
      plugins: Array<{ id: string; extensions: string[]; capabilities: unknown[] }>;
    };

    expect(catalog.plugins).toHaveLength(3);
    for (const plugin of catalog.plugins) {
      expect(plugin.id).toBeTruthy();
      expect(plugin.extensions.length).toBeGreaterThan(0);
      expect(plugin.capabilities.length).toBeGreaterThan(0);
    }
  });
});

describe('integration: diff report contract', () => {
  it('returns versioned DiffReport shape from compareSignalChanges path', () => {
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current: minimalV4Report('c'),
      comparison: {
        compatible: false,
        reason: 'assessment contract mismatch',
        changedFiles: ['src/a.ts'],
        blastRadius: [],
        newSignals: [],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });
    expect(diff.comparison.compatible).toBe(false);
    expect(diff.base).toBeUndefined();
    expect(diff.comparison.riskDelta).toBeUndefined();
    expect(formatDiffConsoleReport(diff)).not.toContain('Base score:');
    expect(formatDiffMarkdownReport(diff)).not.toContain('Base score:');
  });
});

describe('integration: github outputs', () => {
  it('writes summary and annotations with diagnostic evidence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-gh-'));
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current: {
        ...minimalV4Report('c'),
        repository: minimalV4Repository({ regressionRiskScore: 80, confidence: 0.9 }),
        evidence: [sampleV4Evidence()],
      },
      base: {
        ...minimalV4Report('b'),
        repository: minimalV4Repository({ regressionRiskScore: 50, confidence: 0.9 }),
      },
      comparison: {
        compatible: true,
        riskDelta: 30,
        baselineId: 'b',
        changedFiles: ['src/a.ts'],
        blastRadius: [{
          changedFile: 'src/a.ts',
          directDependents: [],
          directDependencies: [],
          transitiveDependents: [],
          transitiveDependencies: [],
          paths: [],
        }],
        newSignals: [{
          evidenceId: 'evidence:dep-cycle:src/a.ts',
          signalId: 'dep-cycle',
          path: 'src/a.ts',
          currentSeverity: 'high',
          message: 'cycle detected',
        }],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const summaryPath = path.join(dir, 'summary.md');
    const annotationsPath = path.join(dir, 'annotations.txt');
    await writeGitHubSummaryFile(diff, summaryPath);
    await writeGitHubAnnotationsFile(diff, annotationsPath);
    const summary = await readFile(summaryPath, 'utf8');
    const annotations = await readFile(annotationsPath, 'utf8');
    expect(summary).toContain('Baseline: b');
    expect(summary).toContain('Base score: 50');
    expect(summary).toContain('## Changed risk clusters');
    expect(summary).toContain('## Top actions');
    expect(summary).toContain('Direct dependencies:');
    expect(annotations).toContain('::error file=src/a.ts');
    expect(formatDiffConsoleReport(diff)).toContain('Base score: 50');
    expect(formatDiffConsoleReport(diff)).toContain('Blast radius:');
    expect(formatDiffConsoleReport(diff)).toContain('Signal changes:');
    expect(formatDiffMarkdownReport(diff)).toContain('Base score: 50');
    expect(formatDiffMarkdownReport(diff)).toContain('### Blast radius');
    expect(formatDiffMarkdownReport(diff)).toContain('[new]');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('integration: CLI locale', () => {
  it('uses config locale ja and --locale en override via real CLI', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-locale-cli-'));
    try {
      await mkdir(path.join(repositoryPath, 'src'), { recursive: true });
      await writeFile(path.join(repositoryPath, 'src', 'a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(repositoryPath, 'r3-doctor.config.json'), JSON.stringify({
        schemaVersion: 1,
        locale: 'ja',
      }));

      const jaReport = JSON.parse((await runCli(['scan', repositoryPath, '--format', 'json'])).stdout) as ScanReport;
      const enReport = JSON.parse((await runCli(['scan', repositoryPath, '--format', 'json', '--locale', 'en'])).stdout) as ScanReport;

      expect(jaReport.metadata.reportLocale).toBe('ja');
      expect(jaReport.repository.disclaimer).toContain('確率');
      expect(enReport.metadata.reportLocale).toBe('en');
      expect(enReport.repository.disclaimer).toContain('probability');
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('keeps score, evidence IDs, and metrics aligned across en and ja CLI output', async () => {
    const repositoryPath = path.join(fixturesRoot, 'fragile-cart');
    const jaReport = JSON.parse((await runCli(['scan', repositoryPath, '--format', 'json', '--locale', 'ja'])).stdout) as ScanReport;
    const enReport = JSON.parse((await runCli(['scan', repositoryPath, '--format', 'json', '--locale', 'en'])).stdout) as ScanReport;

    expect(jaReport.metadata.inputId).toBe(enReport.metadata.inputId);
    expect(jaReport.repository.regressionRiskScore).toBe(enReport.repository.regressionRiskScore);
    expect(jaReport.repository.confidence).toBe(enReport.repository.confidence);
    expect(jaReport.evidence.map((item) => item.evidenceId)).toEqual(enReport.evidence.map((item) => item.evidenceId));
    expect(jaReport.evidence.map((item) => item.metrics)).toEqual(enReport.evidence.map((item) => item.metrics));
  });

  it('rejects unsupported locale with exit code 2', async () => {
    const repositoryPath = path.join(fixturesRoot, 'stable-cart');
    await expect(runCli(['scan', repositoryPath, '--locale', 'fr'])).rejects.toMatchObject({
      code: 2,
    });
  });

  it('streams JSON larger than 64 KiB through a pipe without truncation', async () => {
    const { stdout, exitCode } = await runCliWithPipedStdout(['scan', repoRoot, '--format', 'json', '--locale', 'en']);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(65_536);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe('integration: diff summary without baseline', () => {
  it('shows current score and baseline guidance in summary view', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const diff = await runDiffDiagnosis(repo.path, repo.baseSha);
      const summary = formatDiffConsoleReport(diff, { view: 'summary' });
      expect(diff.comparison.compatible).toBe(false);
      expect(summary).toContain(`Current score: ${diff.current.repository.regressionRiskScore}`);
      expect(summary).toContain('--save-baseline');
    } finally {
      await repo.cleanup();
    }
  });
});
