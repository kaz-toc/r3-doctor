#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';

import { createRepositorySnapshot } from './intake/snapshot.js';
import { runDiagnosis } from './pipeline/diagnose.js';
import { saveBaseline } from './persistence/baseline-store.js';
import { appendTrend, loadTrendHistory } from './persistence/trend-store.js';
import { runDiffDiagnosis } from './commands/diff.js';
import { loadPolicy, evaluatePolicy } from './operations/policy.js';
import { loadCalibration, summarizeCalibration } from './calibration/dataset.js';
import { runGoldenAssessmentRegression } from './calibration/golden-regression.js';
import { DefaultReporterAdapter } from './adapters/reporter.js';
import { analyzeTrend, rankInvestmentPriorities } from './operations/trend.js';
import {
  GoStubAnalyzerPlugin,
  PythonStubAnalyzerPlugin,
  TypeScriptAnalyzerPlugin,
  negotiateCapabilities,
} from './plugins/analyzer.js';
import { extractEvidenceWithPlugins, getDefaultPlugins } from './plugins/analyzer.js';
import { R3DoctorError } from './shared/errors.js';
import { redactDiffReport, redactReport } from './shared/redaction.js';
import { writeGitHubAnnotationsFile, writeGitHubSummaryFile } from './reporting/github.js';
import type { RetentionAudit } from './persistence/retention.js';
import { resolveSafeStorageDir } from './persistence/storage-boundary.js';
import { createOneShotAcpClient } from './semantic/acp/acp-client.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from './semantic/acp/provider-registry.js';
import { buildContextPacket } from './semantic/context-budget.js';
import { normalizeProviderId, selectLlmCandidateFiles } from './semantic/provider.js';
import { buildSemanticPrompt } from './semantic/semantic-prompt.js';
import { parseLlmExecutionPolicy, type LlmCliOptions } from './semantic/execution-policy.js';

const VALID_FORMATS = new Set(['console', 'markdown', 'json']);
const reporter = new DefaultReporterAdapter();

const program = new Command();

program.name('r3-doctor').description('Regression Risk Recovery Doctor').version('0.1.0');

function parseFormat(value: string): 'console' | 'markdown' | 'json' {
  if (!VALID_FORMATS.has(value)) {
    throw new R3DoctorError(`invalid format: ${value}`);
  }
  return value as 'console' | 'markdown' | 'json';
}

function writeRetentionAudits(audits: RetentionAudit[]): void {
  for (const audit of audits) {
    process.stderr.write(
      `retention storage=${audit.storage} reason=${audit.reason} removed=${audit.removedEntries}\n`,
    );
  }
}

function addLlmOptions(command: Command): Command {
  return command
    .option('--llm-provider <id>', 'enable provider (copilot|cursor|codex|claude|openai|anthropic)')
    .option('--llm-model <id>', 'operator-selected provider model')
    .option('--llm-executable <path>', 'operator-selected provider executable')
    .option('--llm-send-scope <scope>', 'changed|cluster-context|all')
    .option('--llm-max-files <count>', 'maximum source files sent to the provider')
    .option('--llm-max-prompt-bytes <count>', 'maximum prompt size in bytes');
}

addLlmOptions(program
  .command('scan')
  .argument('<path>', 'repository path')
  .option('--format <format>', 'console|markdown|json', 'console')
  .option('--save-baseline', 'save report as baseline', false)
  .option('--record-trend', 'append score to trend history', false)
  .option('--dry-run-semantic', 'print semantic prompt without calling the LLM', false)
  .option('--unit <id>', 'monorepo unit id from r3-doctor.config.json'))
  .action(async (
    repoPath: string,
    options: { format: string; saveBaseline: boolean; recordTrend: boolean; dryRunSemantic: boolean; unit?: string } & LlmCliOptions,
  ) => {
    const llmConfig = parseLlmExecutionPolicy(options, options.dryRunSemantic);
    const snapshot = await createRepositorySnapshot(repoPath, options.unit, llmConfig);
    if (options.dryRunSemantic) {
      const plugins = getDefaultPlugins();
      const { evidence } = await extractEvidenceWithPlugins(snapshot, plugins);
      const scopedSnapshot = {
        ...snapshot,
        files: selectLlmCandidateFiles(snapshot, evidence),
      };
      const packet = buildContextPacket(
        scopedSnapshot,
        evidence,
        snapshot.config.llm.maxPromptBytes,
      );
      process.stdout.write(`${buildSemanticPrompt(scopedSnapshot, evidence, packet)}\n`);
      return;
    }

    const format = parseFormat(options.format);
    const report = await runDiagnosis(snapshot);
    const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
    const output = reporter.format(redactReport(report, policy.redactPaths), format);

    if (options.saveBaseline) {
      const baseline = await saveBaseline(snapshot, report);
      process.stderr.write(`baseline saved: ${baseline.path}\n`);
      writeRetentionAudits(baseline.retention);
    }
    if (options.recordTrend) {
      const trend = await appendTrend(snapshot, report);
      writeRetentionAudits(trend.retention);
    }

    process.stdout.write(output);
    process.exit(0);
  });

addLlmOptions(program
  .command('diff')
  .argument('<path>', 'repository path')
  .requiredOption('--base <ref>', 'git ref for baseline comparison')
  .option('--format <format>', 'console|markdown|json', 'console')
  .option('--github-summary <file>', 'write GitHub job summary markdown')
  .option('--github-annotations <file>', 'write GitHub workflow annotations')
  .option('--emit-annotations', 'emit GitHub workflow annotations to stdout'))
  .action(async (
    repoPath: string,
    options: { base: string; format: string; githubSummary?: string; githubAnnotations?: string; emitAnnotations?: boolean } & LlmCliOptions,
  ) => {
    const llmConfig = parseLlmExecutionPolicy(options);
    const diff = await runDiffDiagnosis(repoPath, options.base, llmConfig);
    const format = parseFormat(options.format);
    const snapshot = await createRepositorySnapshot(repoPath);
    const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
    const redacted = redactDiffReport(diff, policy.redactPaths);

    if (options.githubSummary) {
      await writeGitHubSummaryFile(redacted, options.githubSummary);
    }
    if (options.githubAnnotations) {
      await writeGitHubAnnotationsFile(redacted, options.githubAnnotations);
    }
    if (options.emitAnnotations) {
      process.stdout.write(reporter.formatGitHubAnnotations(redacted));
    }

    if (!diff.comparison.compatible) {
      process.stderr.write(`warning: ${diff.comparison.reason ?? 'assessment contract mismatch — risk delta suppressed'}\n`);
    }

    process.stdout.write(reporter.formatDiff(redacted, format));
    process.exit(0);
  });

program
  .command('baseline')
  .argument('<path>', 'repository path')
  .option('--save', 'save current scan as baseline', false)
  .action(async (repoPath: string, options: { save?: boolean }) => {
    const snapshot = await createRepositorySnapshot(repoPath);
    if (options.save) {
      const report = await runDiagnosis(snapshot);
      const baseline = await saveBaseline(snapshot, report);
      writeRetentionAudits(baseline.retention);
      process.stdout.write(`${baseline.path}\n`);
      return;
    }
    process.stdout.write(`inputId: ${snapshot.inputId}\n`);
  });

program
  .command('trend')
  .argument('<path>', 'repository path')
  .option('--analyze', 'detect score degradation and contributing clusters')
  .action(async (repoPath: string, options: { analyze?: boolean }) => {
    const resolved = path.resolve(repoPath);
    const snapshot = await createRepositorySnapshot(resolved);
    let entries: Awaited<ReturnType<typeof loadTrendHistory>> = [];
    try {
      const trendDir = await resolveSafeStorageDir(resolved, snapshot.config.trendDir, 'trendDir', false);
      entries = await loadTrendHistory(path.join(trendDir.path, 'history.jsonl'));
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (!options.analyze) {
      process.stdout.write(`${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(analyzeTrend(entries), null, 2)}\n`);
  });

program
  .command('priorities')
  .argument('<path>', 'repository path')
  .description('improvement investment priority view')
  .action(async (repoPath: string) => {
    const snapshot = await createRepositorySnapshot(repoPath);
    const report = await runDiagnosis(snapshot);
    const priorities = rankInvestmentPriorities(report);
    process.stdout.write(`${JSON.stringify(priorities, null, 2)}\n`);
  });

program
  .command('policy')
  .argument('<path>', 'repository path')
  .option('--evaluate', 'evaluate current score against policy')
  .action(async (repoPath: string, options: { evaluate?: boolean }) => {
    const snapshot = await createRepositorySnapshot(repoPath);
    const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
    if (!options.evaluate) {
      process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
      return;
    }
    const report = await runDiagnosis(snapshot);
    const golden = await runGoldenAssessmentRegression();
    const calibration = await loadCalibration(
      snapshot.repositoryPath,
      golden.passed,
      policy.requiredCalibrationConditions,
    );
    const evaluation = evaluatePolicy(
      report.repository.regressionRiskScore,
      report.repository.confidence,
      policy,
      calibration.gateEligible,
      calibration.missingRequiredConditions,
    );
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    if (evaluation.gateWouldFail) {
      process.exit(1);
    }
  });

program
  .command('calibration')
  .argument('<path>', 'repository path')
  .option('--golden', 'run golden assessment regression check')
  .action(async (repoPath: string, options: { golden?: boolean }) => {
    if (options.golden) {
      const report = await runGoldenAssessmentRegression();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.passed) {
        process.exit(1);
      }
      return;
    }
    const snapshot = await createRepositorySnapshot(path.resolve(repoPath));
    const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
    const golden = await runGoldenAssessmentRegression();
    const calibration = await loadCalibration(
      snapshot.repositoryPath,
      golden.passed,
      policy.requiredCalibrationConditions,
    );
    process.stdout.write(`${summarizeCalibration(calibration)}\n`);
  });

program
  .command('plugins')
  .description('list analyzer plugin capabilities')
  .action(async () => {
    const plugins = [new TypeScriptAnalyzerPlugin(), new PythonStubAnalyzerPlugin(), new GoStubAnalyzerPlugin()];
    const negotiation = negotiateCapabilities(
      {
        repositoryPath: process.cwd(),
        files: [],
        inputId: 'plugins',
        gitAvailable: false,
        gitDirty: false,
        analysisContextFingerprint: '0'.repeat(64),
        truncated: false,
        intakeIssues: [],
        config: { schemaVersion: 1 } as never,
      },
      plugins,
    );
    process.stdout.write(`${JSON.stringify({ plugins: plugins.map((p) => p.id), ...negotiation }, null, 2)}\n`);
  });

const llm = program.command('llm').description('LLM provider utilities');

llm
  .command('inspect')
  .description('inspect configured LLM provider availability')
  .option('--provider <id>', 'provider id (copilot|cursor|codex|claude|openai|anthropic)')
  .option('--path <path>', 'repository path used as ACP runtime directory', process.cwd())
  .action(async (options: { provider?: string; path: string }) => {
    const providerRaw = options.provider ?? 'codex';
    const providerId = normalizeProviderId(providerRaw);
    if (!providerId || providerId === 'none') {
      throw new R3DoctorError(`invalid provider: ${providerRaw}`);
    }

    const definition = getLlmProviderDefinition(providerId);
    const repositoryPath = path.resolve(options.path);
    const spec = buildLlmLaunchSpec(providerId, {
      executablePath: definition.defaultExecutablePath,
      modelIdentifier: providerId === 'copilot' ? 'auto' : '',
      runtimeDirectory: repositoryPath,
      inheritedEnv: process.env,
    });

    const client = createOneShotAcpClient();
    const result = await client.inspect({ spec });

    if (result.ok) {
      process.stderr.write(`provider=${providerId} status=available\n`);
      if (result.value.agentInfo) {
        process.stderr.write(`agent=${result.value.agentInfo.name}${result.value.agentInfo.version ? `@${result.value.agentInfo.version}` : ''}\n`);
      }
      process.stderr.write(`authMethods=${result.value.authMethods.map((method) => method.id).join(',') || 'none'}\n`);
      process.exit(0);
    }

    process.stderr.write(`provider=${providerId} status=unavailable reason=${result.reason}\n`);
    process.stderr.write(`installHint=${definition.installHint}\n`);
    process.exit(result.reason === 'executable_missing' ? 1 : 2);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`r3-doctor: ${message}\n`);
  const exitCode = error instanceof R3DoctorError ? error.exitCode : 2;
  process.exit(exitCode);
});
