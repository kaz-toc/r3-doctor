import path from 'node:path';

import { Command } from 'commander';

import { DefaultReporterAdapter } from '../adapters/reporter.js';
import { createRepositorySnapshot, type RepositorySnapshot } from '../intake/snapshot.js';
import { runDiagnosis } from '../pipeline/diagnose.js';
import { saveBaseline } from '../persistence/baseline-store.js';
import { appendTrend } from '../persistence/trend-store.js';
import { loadPolicy } from '../operations/policy.js';
import { extractEvidenceWithPlugins, getDefaultPlugins } from '../plugins/analyzer.js';
import { parseReportLocale } from '../i18n/locale.js';
import { normalizeConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';
import { redactReport } from '../shared/redaction.js';
import type { RetentionAudit } from '../persistence/retention.js';
import { selectLlmCandidateFiles } from '../semantic/provider.js';
import { buildBudgetedSemanticPrompt } from '../semantic/semantic-prompt.js';
import { parseLlmExecutionPolicy, type LlmCliOptions } from '../semantic/execution-policy.js';
import type { OperatorProfile } from '../operator/profile.js';

const VALID_FORMATS = new Set(['console', 'markdown', 'json']);
const VALID_VIEWS = new Set(['facts', 'summary', 'actions', 'all']);
const reporter = new DefaultReporterAdapter();

export type ScanActionOptions = {
  repoPath: string;
  format?: string;
  view?: string;
  saveBaseline?: boolean;
  recordTrend?: boolean;
  dryRunSemantic?: boolean;
  unit?: string;
  locale?: string;
  operatorProfile?: OperatorProfile | null;
} & LlmCliOptions;

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

export async function runScanAction(options: ScanActionOptions): Promise<void> {
  const llmConfig = parseLlmExecutionPolicy(options, Boolean(options.dryRunSemantic), options.operatorProfile);
  const snapshot = applyLocaleOverride(
    await createRepositorySnapshot(options.repoPath, options.unit, llmConfig),
    options.locale,
  );

  if (options.dryRunSemantic) {
    const plugins = getDefaultPlugins();
    const { evidence } = await extractEvidenceWithPlugins(snapshot, plugins);
    const scopedSnapshot = {
      ...snapshot,
      files: selectLlmCandidateFiles(snapshot, evidence),
    };
    const { prompt } = buildBudgetedSemanticPrompt(
      scopedSnapshot,
      evidence,
      snapshot.config.llm.maxPromptBytes,
    );
    process.stdout.write(`${prompt}\n`);
    return;
  }

  const format = parseFormat(options.format ?? 'console');
  const view = parseView(options.view ?? 'all');
  const report = await runDiagnosis(snapshot);
  const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
  const output = reporter.format(redactReport(report, policy.redactPaths), format, { view });

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

export function registerScanCommand(program: Command): void {
  addLlmOptions(program
    .command('scan')
    .argument('<path>', 'repository path')
    .option('--format <format>', 'console|markdown|json', 'console')
    .option('--view <view>', 'facts|summary|actions|all (console/markdown projection; json always returns full report)', 'all')
    .option('--save-baseline', 'save report as baseline', false)
    .option('--record-trend', 'append score to trend history', false)
    .option('--dry-run-semantic', 'print semantic prompt without calling the LLM', false)
    .option('--unit <id>', 'monorepo unit id from r3-doctor.config.json')
    .option('--locale <en|ja>', 'report narrative locale (overrides config)'))
    .action(async (
      repoPath: string,
      options: {
        format: string;
        view: string;
        saveBaseline: boolean;
        recordTrend: boolean;
        dryRunSemantic: boolean;
        unit?: string;
        locale?: string;
        profile?: string;
      } & LlmCliOptions,
    ) => {
      const { loadOperatorProfile } = await import('../operator/profile.js');
      const operatorProfile = await loadOperatorProfile(options.profile);
      await runScanAction({
        repoPath: path.resolve(repoPath),
        format: options.format,
        view: options.view,
        saveBaseline: options.saveBaseline,
        recordTrend: options.recordTrend,
        dryRunSemantic: options.dryRunSemantic,
        unit: options.unit,
        locale: options.locale,
        operatorProfile,
        llmProvider: options.llmProvider,
        llmModel: options.llmModel,
        llmExecutable: options.llmExecutable,
        llmSendScope: options.llmSendScope,
        llmMaxFiles: options.llmMaxFiles,
        llmMaxPromptBytes: options.llmMaxPromptBytes,
      });
    });
}

export { addLlmOptions as addScanLlmOptions };
