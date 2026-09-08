import type { ReportLocale } from '../i18n/locale.js';
import type { RepositoryConfig } from '../shared/config.js';

import { configFileExists } from './detect.js';
import { setupT } from './messages.js';
import { createSetupPrompts, suggestedInteractiveLocale } from './prompts.js';

export type InteractiveSetupChoices = {
  locale: ReportLocale;
  dryRun: boolean;
  force: boolean;
  skipLlm: boolean;
  skipBaseline: boolean;
  runScan: boolean;
  saveBaseline: boolean;
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
    if (configExists && !force) {
      force = await prompts.confirm(setupT(locale, 'setup.prompt.overwriteConfig'), false);
    }

    let dryRun = Boolean(options.dryRun);
    if (!dryRun) {
      dryRun = !(await prompts.confirm(setupT(locale, 'setup.prompt.writeConfig'), true));
    }

    let runScan = false;
    let saveBaseline = false;
    if (!dryRun) {
      runScan = await prompts.confirm(setupT(locale, 'setup.prompt.runScan'), false);
      if (runScan) {
        saveBaseline = await prompts.confirm(setupT(locale, 'setup.prompt.saveBaseline'), false);
      }
    }

    const skipLlm = options.skipLlm ?? !(await prompts.confirm(setupT(locale, 'setup.prompt.showLlmSteps'), true));
    const skipBaseline = options.skipBaseline ?? false;

    return {
      locale,
      dryRun,
      force,
      skipLlm,
      skipBaseline,
      runScan,
      saveBaseline,
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
