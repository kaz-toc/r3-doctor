import path from 'node:path';

import { DefaultGitProvider } from '../adapters/git-provider.js';
import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig } from '../shared/config.js';
import { ConfigError } from '../shared/errors.js';
import type { ReportLocale } from '../i18n/locale.js';
import { runLlmInspect } from '../commands/llm-inspect.js';

import { configFileExists, countBaselineEntries } from './detect.js';
import { setupT } from './messages.js';
import type { CheckReport } from './schema.js';

const MIN_NODE_MAJOR = 22;

export type RunCheckOptions = {
  repositoryPath: string;
  locale: ReportLocale;
  inspectLlm?: boolean;
  llmProvider?: string;
};

function parseNodeMajor(version: string): number {
  const match = /^v(\d+)/.exec(version);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

export async function runCheck(options: RunCheckOptions): Promise<CheckReport> {
  const repositoryPath = path.resolve(options.repositoryPath);
  const locale = options.locale;
  const warnings: string[] = [];
  const errors: string[] = [];

  const nodeMajor = parseNodeMajor(process.version);
  const node = {
    ok: nodeMajor >= MIN_NODE_MAJOR,
    detail: process.version,
  };
  if (!node.ok) {
    errors.push(setupT(locale, 'check.node.fail', { version: process.version, required: MIN_NODE_MAJOR }));
  }

  let git = { ok: false, detail: setupT(locale, 'check.git.missing') };
  try {
    const gitState = await new DefaultGitProvider().inspectRepository(repositoryPath);
    if (gitState) {
      git = {
        ok: true,
        detail: setupT(locale, 'check.git.ok', {
          sha: gitState.headSha.slice(0, 7),
          dirty: gitState.dirty ? setupT(locale, 'check.git.dirtySuffix') : '',
        }),
      };
      if (gitState.dirty) {
        warnings.push(setupT(locale, 'check.warn.dirty', { path: repositoryPath }));
      }
    }
  } catch {
    warnings.push(setupT(locale, 'check.git.missing'));
  }

  let config = { ok: false, detail: setupT(locale, 'check.config.missing') };
  const configExists = await configFileExists(repositoryPath);
  try {
    await loadConfig(repositoryPath, defaultLlmConfig);
    config = {
      ok: true,
      detail: configExists
        ? setupT(locale, 'check.config.ok')
        : setupT(locale, 'check.config.default'),
    };
    if (!configExists) {
      warnings.push(setupT(locale, 'check.warn.configMissing'));
    }
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : String(error);
    config = { ok: false, detail: reason };
    errors.push(reason);
  }

  let baselineCount = 0;
  let baseline = { ok: false, detail: setupT(locale, 'check.baseline.missing') };
  try {
    const loaded = await loadConfig(repositoryPath, defaultLlmConfig);
    baselineCount = await countBaselineEntries(repositoryPath, loaded.baselineDir);
    baseline = {
      ok: baselineCount > 0,
      detail: baselineCount > 0
        ? setupT(locale, 'check.baseline.ok', { count: baselineCount })
        : setupT(locale, 'check.baseline.missing'),
    };
    if (baselineCount === 0) {
      warnings.push(setupT(locale, 'check.warn.baselineMissing'));
    }
  } catch {
    warnings.push(setupT(locale, 'check.baseline.missing'));
  }

  let llm: CheckReport['checks']['llm'];
  if (options.inspectLlm) {
    const inspect = await runLlmInspect({
      provider: options.llmProvider ?? 'codex',
      path: repositoryPath,
    });
    llm = {
      ok: inspect.exitCode === 0,
      detail: inspect.stderr.trim(),
    };
    if (inspect.exitCode !== 0) {
      warnings.push(setupT(locale, 'check.warn.llmUnavailable'));
    }
  }

  const ready = node.ok && config.ok && errors.length === 0;

  return {
    schemaVersion: 1,
    locale,
    repositoryPath,
    ready,
    checks: {
      node,
      git,
      config,
      baseline,
      ...(llm ? { llm } : {}),
    },
    warnings,
    errors,
  };
}

export function formatCheckConsole(report: CheckReport): string {
  const locale = report.locale;
  const lines = [
    setupT(locale, 'check.title'),
    `- node: ${report.checks.node.detail}`,
    `- git: ${report.checks.git.detail}`,
    `- config: ${report.checks.config.detail}`,
    `- baseline: ${report.checks.baseline.detail}`,
  ];
  if (report.checks.llm) {
    lines.push(`- llm: ${report.checks.llm.detail}`);
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`error: ${error}`);
  }
  lines.push(report.ready ? setupT(locale, 'check.ready') : setupT(locale, 'check.notReady'));
  return `${lines.join('\n')}\n`;
}

export function checkExitCode(report: CheckReport): 0 | 2 {
  return report.errors.length > 0 ? 2 : 0;
}
