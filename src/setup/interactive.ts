import type { ReportLocale } from '../i18n/locale.js';
import type { RepositoryConfig } from '../shared/config.js';

import { assessBaselineSaveEligibility } from './baseline-eligibility.js';
import { runLlmInspect } from '../commands/llm-inspect.js';
import { configFileExists } from './detect.js';
import { SETUP_LLM_PROVIDER_OPTIONS, type SetupLlmProviderId } from './llm-providers.js';
import { BASELINE_BLOCKED_MESSAGE_KEYS, setupT } from './messages.js';
import { createSetupPrompts, suggestedInteractiveLocale } from './prompts.js';

export type InteractiveSetupChoices = {
  locale: ReportLocale;
  dryRun: boolean;
  force: boolean;
  skipLlm: boolean;
  skipBaseline: boolean;
  runScan: boolean;
  saveBaseline: boolean;
  configureLlm: boolean;
  llmProvider?: SetupLlmProviderId;
  saveOperatorProfile: boolean;
  llmInspectAvailable: boolean;
};

export async function runInteractiveSetupChoices(
  repositoryPath: string,
  options: { dryRun?: boolean; force?: boolean; skipLlm?: boolean; skipBaseline?: boolean },
): Promise<InteractiveSetupChoices> {
  const prompts = await createSetupPrompts();
  try {
    const locale = await prompts.selectLocale(suggestedInteractiveLocale());
    process.stdout.write(`\n${setupT(locale, 'setup.title')}\n`);

    const configExists = await configFileExists(repositoryPath);
    let force = Boolean(options.force);
    let dryRun = Boolean(options.dryRun);

    if (configExists && !force) {
      force = await prompts.confirm(setupT(locale, 'setup.prompt.overwriteConfig'), false);
    } else if (!configExists && !dryRun) {
      dryRun = !(await prompts.confirm(setupT(locale, 'setup.prompt.createConfig'), true));
    }

    let configureLlm = false;
    let llmProvider: SetupLlmProviderId | undefined;
    let saveOperatorProfile = false;
    let llmInspectAvailable = false;

    if (!options.skipLlm) {
      configureLlm = await prompts.confirm(setupT(locale, 'setup.prompt.configureLlm'), true);
      if (configureLlm) {
        llmProvider = await prompts.selectProvider(
          setupT(locale, 'setup.prompt.selectLlmProvider'),
          SETUP_LLM_PROVIDER_OPTIONS,
        );
        const inspect = await runLlmInspect({ provider: llmProvider, path: repositoryPath });
        llmInspectAvailable = inspect.exitCode === 0;
        if (inspect.stderr) {
          process.stderr.write(inspect.stderr);
        }
        if (llmInspectAvailable) {
          saveOperatorProfile = await prompts.confirm(setupT(locale, 'setup.prompt.saveOperatorProfile'), true);
        } else {
          process.stdout.write(`\n${setupT(locale, 'setup.llm.setupDeferred')}\n`);
        }
      }
    }

    let runScan = false;
    let saveBaseline = false;
    if (!dryRun) {
      runScan = await prompts.confirm(setupT(locale, 'setup.prompt.runScan'), false);
      if (runScan) {
        const willWriteConfig = !configExists || force;
        const eligibility = await assessBaselineSaveEligibility(repositoryPath, { willWriteConfig });
        if (eligibility.eligible) {
          saveBaseline = await prompts.confirm(setupT(locale, 'setup.prompt.saveBaseline'), false);
        } else if (eligibility.reason) {
          process.stdout.write(`\n${setupT(locale, BASELINE_BLOCKED_MESSAGE_KEYS[eligibility.reason], { path: repositoryPath })}\n`);
        }
      }
    }

    const skipLlm = options.skipLlm || !configureLlm;
    const skipBaseline = options.skipBaseline ?? false;

    return {
      locale,
      dryRun,
      force,
      skipLlm,
      skipBaseline,
      runScan,
      saveBaseline,
      configureLlm,
      llmProvider,
      saveOperatorProfile,
      llmInspectAvailable,
    };
  } finally {
    await prompts.close();
  }
}

export function applyInteractiveExclude(
  proposed: RepositoryConfig,
  locale: ReportLocale,
  acceptSuggested: boolean,
): RepositoryConfig {
  if (acceptSuggested) {
    return proposed;
  }
  return {
    ...proposed,
    exclude: ['node_modules', 'dist', 'build', 'coverage'],
  };
}
