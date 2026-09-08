import path from 'node:path';

import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig, type RepositoryConfig } from '../shared/config.js';
import type { ReportLocale } from '../i18n/locale.js';

import { assessBaselineSaveEligibility } from './baseline-eligibility.js';
import { configFileExists, countBaselineEntries, detectRepository } from './detect.js';
import { BASELINE_BLOCKED_MESSAGE_KEYS, setupT } from './messages.js';
import { buildNextSteps } from './next-steps.js';
import { configureOperatorLlm, formatLlmSetupConsole, saveSetupLlmProfile, type LlmSetupReport } from './llm-setup.js';
import { defaultOperatorProfilePath } from '../operator/profile.js';
import type { SetupLlmProviderId } from './llm-providers.js';
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
  configureLlm?: boolean;
  llmProvider?: SetupLlmProviderId;
  saveOperatorProfile?: boolean;
  llmInspectAvailable?: boolean;
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
  let llmSetup: LlmSetupReport | undefined;
  if (options.configureLlm && options.llmProvider) {
    try {
      if (options.llmInspectAvailable === undefined) {
        llmSetup = await configureOperatorLlm({
          locale: options.locale,
          repositoryPath,
          provider: options.llmProvider,
          saveProfile: Boolean(options.saveOperatorProfile),
        });
      } else {
        const profilePath = defaultOperatorProfilePath();
        llmSetup = {
          attempted: true,
          provider: options.llmProvider,
          inspectAvailable: options.llmInspectAvailable,
          inspectDetail: '',
          profilePath,
          profileWritten: false,
        };
        if (options.saveOperatorProfile && options.llmInspectAvailable) {
          await saveSetupLlmProfile(options.llmProvider, profilePath);
          llmSetup.profileWritten = true;
        }
      }
      if (llmSetup && !llmSetup.inspectAvailable) {
        warnings.push(setupT(options.locale, 'setup.llm.unavailable'));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(reason);
    }
  }

  const nextSteps = buildNextSteps(options.locale, repositoryPath, {
    skipLlm: options.skipLlm || Boolean(llmSetup?.profileWritten),
    skipBaseline: options.skipBaseline || Boolean(options.saveBaseline),
    hasBaseline: hasBaseline || Boolean(options.saveBaseline),
    llmProvider: llmSetup?.profileWritten ? llmSetup.provider : undefined,
  });

  let scanRan = false;
  let baselineSaved = false;
  let saveBaseline = Boolean(options.saveBaseline);
  if (saveBaseline && options.runScan && errors.length === 0) {
    const eligibility = await assessBaselineSaveEligibility(repositoryPath, {
      willWriteConfig: configWritten,
    });
    if (!eligibility.eligible && eligibility.reason) {
      warnings.push(setupT(options.locale, BASELINE_BLOCKED_MESSAGE_KEYS[eligibility.reason], { path: repositoryPath }));
      saveBaseline = false;
    }
  }

  if (options.runScan && errors.length === 0 && (configWritten || configSkipped)) {
    try {
      const { runScanAction } = await import('../commands/scan.js');
      await runScanAction({
        repoPath: repositoryPath,
        format: 'json',
        saveBaseline,
        locale: options.locale,
      });
      scanRan = true;
      baselineSaved = saveBaseline;
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
    operatorProfile: llmSetup
      ? {
          attempted: llmSetup.attempted,
          provider: llmSetup.provider,
          inspectAvailable: llmSetup.inspectAvailable,
          profilePath: llmSetup.profilePath,
          profileWritten: llmSetup.profileWritten,
        }
      : undefined,
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
  if (report.operatorProfile) {
    lines.push(...formatLlmSetupConsole(locale, {
      attempted: report.operatorProfile.attempted,
      provider: report.operatorProfile.provider as SetupLlmProviderId | undefined,
      inspectAvailable: report.operatorProfile.inspectAvailable,
      inspectDetail: '',
      profilePath: report.operatorProfile.profilePath,
      profileWritten: report.operatorProfile.profileWritten,
    }));
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
