import type { ReportLocale } from '../i18n/locale.js';
import type { RepositoryConfig } from '../shared/config.js';
import {
  discoverLlmModels,
  knownLlmModelChoices,
  toLlmModelChoices,
} from '../semantic/llm/discover.js';

import { assessBaselineSaveEligibility } from './baseline-eligibility.js';
import { configFileExists } from './detect.js';
import {
  findCatalogProvider,
  probeSetupLlmProviders,
  toAvailableSetupProviderOptions,
} from './llm-probe.js';
import type { SetupLlmProviderId } from './llm-providers.js';
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
  llmModel?: string;
  saveOperatorProfile: boolean;
  llmInspectAvailable: boolean;
};

async function probeProvidersWithProgress(locale: ReportLocale): Promise<Awaited<ReturnType<typeof probeSetupLlmProviders>>> {
  let spinner: { start: (message?: string) => void; message: (message: string) => void; stop: (message?: string) => void } | undefined;
  try {
    const clack = await import('@clack/prompts');
    if (process.stdout.isTTY) {
      spinner = clack.spinner();
      spinner.start(setupT(locale, 'setup.prompt.probingProvidersNotice'));
    }
  } catch {
    process.stdout.write(`\n${setupT(locale, 'setup.prompt.probingProvidersNotice')}\n`);
  }

  const catalog = await probeSetupLlmProviders({
    onProgress: ({ displayName, current, total }) => {
      const message = setupT(locale, 'setup.prompt.probingProvider', {
        provider: displayName,
        current: String(current),
        total: String(total),
      });
      if (spinner) {
        spinner.message(message);
      } else {
        process.stdout.write(`${message}\n`);
      }
    },
  });

  spinner?.stop('');
  return catalog;
}

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

    let configureLlm = false;
    let llmProvider: SetupLlmProviderId | undefined;
    let llmModel: string | undefined;
    let saveOperatorProfile = false;
    let llmInspectAvailable = false;

    if (!options.skipLlm) {
      configureLlm = await prompts.confirm(setupT(locale, 'setup.prompt.configureLlm'), true);
      if (configureLlm) {
        const catalog = await probeProvidersWithProgress(locale);
        const availableProviders = toAvailableSetupProviderOptions(catalog);
        if (availableProviders.length === 0) {
          process.stdout.write(`\n${setupT(locale, 'setup.llm.noProvidersAvailable')}\n`);
        } else {
          llmProvider = await prompts.selectProvider(
            setupT(locale, 'setup.prompt.selectLlmProvider'),
            availableProviders,
          );
          llmInspectAvailable = true;

          const selectedCatalog = findCatalogProvider(catalog, llmProvider);
          if (selectedCatalog?.inspect.status === 'available' && (selectedCatalog.inspect.authMethods?.length ?? 0) > 0) {
            process.stdout.write(`\n${setupT(locale, 'setup.llm.authHint', { provider: selectedCatalog.displayName })}\n`);
          }

          const discovered = await discoverLlmModels({ provider: llmProvider });
          const modelCatalog = discovered.ok
            ? discovered.value
            : knownLlmModelChoices(llmProvider);
          if (!discovered.ok) {
            process.stdout.write(`\n${setupT(locale, 'setup.llm.modelsUnavailable', { provider: llmProvider })}\n`);
          }

          const modelChoices = toLlmModelChoices(modelCatalog.models).map((choice) => ({
            value: choice.modelIdentifier,
            label: choice.modelIdentifier === ''
              ? setupT(locale, 'setup.llm.modelLabelDefault')
              : choice.label || choice.modelIdentifier,
          }));
          const selectedModel = await prompts.selectModel(
            setupT(locale, 'setup.prompt.selectLlmModel'),
            modelChoices,
          );
          llmModel = selectedModel.trim() || undefined;

          saveOperatorProfile = await prompts.confirm(setupT(locale, 'setup.prompt.saveOperatorProfile'), true);
        }
      }
    }

    if (configureLlm && !llmInspectAvailable) {
      process.stdout.write(`\n${setupT(locale, 'setup.llm.setupDeferred')}\n`);
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
      llmModel,
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
