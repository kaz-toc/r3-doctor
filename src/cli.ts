#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';

import { createRepositorySnapshot } from './intake/snapshot.js';
import { runDiagnosis } from './pipeline/diagnose.js';
import { saveBaseline } from './persistence/baseline-store.js';
import { appendTrend, loadTrendHistory } from './persistence/trend-store.js';
import { runDiffDiagnosis } from './commands/diff.js';
import { registerCheckCommand } from './commands/check.js';
import { registerLlmInspectCommand } from './commands/llm-inspect.js';
import { registerScanCommand } from './commands/scan.js';
import { registerSetupCommand } from './commands/setup.js';
import { loadPolicy, evaluatePolicy } from './operations/policy.js';
import { loadCalibration, summarizeCalibration } from './calibration/dataset.js';
import { summarizeCalibrationQuality } from './calibration/quality.js';
import { runGoldenAssessmentRegression } from './calibration/golden-regression.js';
import { DefaultReporterAdapter } from './adapters/reporter.js';
import { analyzeTrend, rankInvestmentPriorities } from './operations/trend.js';
import {
  GoStubAnalyzerPlugin,
  PythonStubAnalyzerPlugin,
  TypeScriptAnalyzerPlugin,
} from './plugins/analyzer.js';
import { R3DoctorError } from './shared/errors.js';
import { normalizeConfig } from './shared/config.js';
import { parseReportLocale } from './i18n/locale.js';
import type { RepositorySnapshot } from './intake/snapshot.js';
import { redactDiffReport, redactReport } from './shared/redaction.js';
import { writeGitHubAnnotationsFile, writeGitHubSummaryFile } from './reporting/github.js';
import type { RetentionAudit } from './persistence/retention.js';
import { resolveSafeStorageDir } from './persistence/storage-boundary.js';
import { parseLlmExecutionPolicy, type LlmCliOptions } from './semantic/execution-policy.js';
import { loadOperatorProfile } from './operator/profile.js';

const VALID_FORMATS = new Set(['console', 'markdown', 'json']);
const VALID_VIEWS = new Set(['facts', 'summary', 'actions', 'all']);
const reporter = new DefaultReporterAdapter();

const program = new Command();

program.name('r3-doctor').description('Regression Risk Recovery Doctor').version('0.1.1');

function parseFormat(value: string): 'console' | 'markdown' | 'json' {
  if (!VALID_FORMATS.has(value)) {
    throw new R3DoctorError(`invalid format: ${value}`);
  }
  return value as 'console' | 'markdown' | 'json';
}

function parseView(value: string): 'facts' | 'summary' | 'actions' | 'all' {
  if (!VALID_VIEWS.has(value)) {
    throw new R3DoctorError('expected one of: facts, summary, actions, all');
  }
  return value as 'facts' | 'summary' | 'actions' | 'all';
}

function applyLocaleOverride(snapshot: RepositorySnapshot, locale?: string): RepositorySnapshot {
  if (!locale) {
    return snapshot;
  }
  const parsed = parseReportLocale(locale);
  return {
    ...snapshot,
    config: normalizeConfig({ ...snapshot.config, locale: parsed }),
  };
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
    .option('--llm-max-prompt-bytes <count>', 'maximum prompt size in bytes')
    .option('--profile <path>', 'operator profile JSON (defaults to ~/.config/r3-doctor/profile.json)');
}

registerScanCommand(program);

addLlmOptions(program
  .command('diff')
  .argument('<path>', 'repository path')
  .requiredOption('--base <ref>', 'git ref for baseline comparison')
  .option('--format <format>', 'console|markdown|json', 'console')
  .option('--view <view>', 'facts|summary|actions|all (console/markdown projection; json always returns full report)', 'all')
  .option('--github-summary <file>', 'write GitHub job summary markdown')
  .option('--github-annotations <file>', 'write GitHub workflow annotations')
  .option('--emit-annotations', 'emit GitHub workflow annotations to stdout')
  .option('--locale <en|ja>', 'report narrative locale (overrides config)'))
  .action(async (
    repoPath: string,
    options: { base: string; format: string; view: string; githubSummary?: string; githubAnnotations?: string; emitAnnotations?: boolean; locale?: string; profile?: string } & LlmCliOptions,
  ) => {
    const operatorProfile = await loadOperatorProfile(options.profile);
    const llmConfig = parseLlmExecutionPolicy(options, false, operatorProfile);
    const snapshot = applyLocaleOverride(await createRepositorySnapshot(repoPath, undefined, llmConfig), options.locale);
    const diff = await runDiffDiagnosis(repoPath, options.base, llmConfig, snapshot);
    const format = parseFormat(options.format);
    const view = parseView(options.view);
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

    process.stdout.write(reporter.formatDiff(redacted, format, { view }));
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
    const quality = summarizeCalibrationQuality(calibration);
    process.stdout.write(
      `${summarizeCalibration(calibration)}\nQuality status: ${quality.status}\n`,
    );
  });

program
  .command('plugins')
  .description('list analyzer plugin capabilities')
  .action(async () => {
    const plugins = [new TypeScriptAnalyzerPlugin(), new PythonStubAnalyzerPlugin(), new GoStubAnalyzerPlugin()];
    process.stdout.write(`${JSON.stringify({
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        implementationVersion: plugin.implementationVersion,
        extensions: plugin.extensions,
        capabilities: plugin.capabilities,
      })),
    }, null, 2)}\n`);
  });

registerCheckCommand(program);
registerSetupCommand(program);
registerLlmInspectCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`r3-doctor: ${message}\n`);
  const exitCode = error instanceof R3DoctorError ? error.exitCode : 2;
  process.exit(exitCode);
});
