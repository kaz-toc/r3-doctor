import path from 'node:path';

import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig, type RepositoryConfig } from '../shared/config.js';
import type { ReportLocale } from '../i18n/locale.js';

import { configFileExists, countBaselineEntries, detectRepository } from './detect.js';
import { setupT } from './messages.js';
import { buildNextSteps } from './next-steps.js';
import type { SetupReport } from './schema.js';
import { CONFIG_FILE_NAME, writeRepositoryConfig } from './write-config.js';

export type RunSetupOptions = {
  repositoryPath: string;
  locale: ReportLocale;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  skipLlm?: boolean;
  skipBaseline?: boolean;
  runScan?: boolean;
  saveBaseline?: boolean;
  proposedConfig?: RepositoryConfig;
};

export async function runSetup(options: RunSetupOptions): Promise<SetupReport> {
  const repositoryPath = path.resolve(options.repositoryPath);
  const warnings: string[] = [];
  const errors: string[] = [];
  const detected = await detectRepository(repositoryPath, options.locale);
  const proposedConfig = options.proposedConfig ?? detected.proposedConfig;

  const configExists = await configFileExists(repositoryPath);
  let configSkipped = false;
  let configWritten = false;
  const configPath = path.join(repositoryPath, CONFIG_FILE_NAME);

  if (configExists && !options.force) {
    configSkipped = true;
    warnings.push(setupT(options.locale, 'setup.warn.configExists'));
  } else {
    const baselineCount = await countBaselineEntries(repositoryPath, proposedConfig.baselineDir);
    if (baselineCount > 0 && !options.force) {
      errors.push(setupT(options.locale, 'setup.warn.baselineExists', { count: baselineCount }));
    } else if (!options.dryRun) {
      await writeRepositoryConfig(repositoryPath, proposedConfig);
      configWritten = true;
      try {
        await loadConfig(repositoryPath, defaultLlmConfig);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push(reason);
      }
    } else {
      warnings.push(setupT(options.locale, 'setup.dryRun'));
    }
  }

  const hasBaseline = await countBaselineEntries(repositoryPath, proposedConfig.baselineDir) > 0;
  const nextSteps = buildNextSteps(options.locale, repositoryPath, {
    skipLlm: options.skipLlm,
    skipBaseline: options.skipBaseline || Boolean(options.saveBaseline),
    hasBaseline: hasBaseline || Boolean(options.saveBaseline),
  });

  let scanRan = false;
  let baselineSaved = false;
  if (options.runScan && errors.length === 0 && (configWritten || configSkipped)) {
    try {
      const { runScanAction } = await import('../commands/scan.js');
      await runScanAction({
        repoPath: repositoryPath,
        format: 'json',
        saveBaseline: Boolean(options.saveBaseline),
        locale: options.locale,
      });
      scanRan = true;
      baselineSaved = Boolean(options.saveBaseline);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(reason);
    }
  }

  return {
    schemaVersion: 1,
    locale: options.locale,
    repositoryPath,
    dryRun: options.dryRun,
    configSkipped,
    configWritten,
    configPath,
    scanRan,
    baselineSaved,
    detected: {
      workspaces: detected.workspaces,
      suggestedExclude: detected.suggestedExclude,
      hasGitignore: detected.hasGitignore,
    },
    nextSteps,
    warnings,
    errors,
  };
}

export function formatSetupConsole(report: SetupReport): string {
  const locale = report.locale;
  const lines = [setupT(locale, 'setup.title')];

  if (report.dryRun) {
    lines.push(setupT(locale, 'setup.dryRun'));
  }
  if (report.configWritten) {
    lines.push(setupT(locale, 'setup.configWritten', { path: report.configPath }));
  }
  if (report.configSkipped) {
    lines.push(setupT(locale, 'setup.configSkipped', { path: report.configPath }));
  }
  if (report.scanRan) {
    lines.push(setupT(locale, 'setup.scanCompleted'));
  }
  if (report.baselineSaved) {
    lines.push(setupT(locale, 'setup.baselineSaved'));
  }

  if (report.detected.workspaces.length > 0) {
    lines.push(setupT(locale, 'setup.detect.workspaces', { list: report.detected.workspaces.join(', ') }));
  }
  lines.push(setupT(locale, 'setup.detect.exclude', { list: report.detected.suggestedExclude.join(', ') }));

  if (report.detected.hasGitignore) {
    lines.push(setupT(locale, 'setup.gitignore.hint'));
  }

  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`error: ${error}`);
  }

  lines.push('', formatNextStepsBlock(locale, report.nextSteps));
  return `${lines.join('\n')}\n`;
}

function formatNextStepsBlock(locale: ReportLocale, steps: string[]): string {
  return [
    setupT(locale, 'setup.next.title'),
    ...steps.map((step) => `- ${step}`),
  ].join('\n');
}

export function setupExitCode(report: SetupReport): 0 | 2 {
  return report.errors.length > 0 ? 2 : 0;
}
