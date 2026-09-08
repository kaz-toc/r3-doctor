import { runLlmInspect } from '../commands/llm-inspect.js';
import {
  defaultOperatorProfilePath,
  loadOperatorProfile,
  saveOperatorProfile,
  type OperatorProfile,
} from '../operator/profile.js';
import type { ReportLocale } from '../i18n/locale.js';
import { llmProviderSchema } from '../shared/config.js';

import { setupT } from './messages.js';
import type { SetupLlmProviderId } from './llm-providers.js';

export type LlmSetupOptions = {
  locale: ReportLocale;
  repositoryPath: string;
  provider: SetupLlmProviderId;
  saveProfile: boolean;
  profilePath?: string;
};

export type LlmSetupReport = {
  attempted: boolean;
  provider?: SetupLlmProviderId;
  inspectAvailable: boolean;
  inspectDetail: string;
  profilePath?: string;
  profileWritten: boolean;
};

function parseSetupProvider(provider: string): SetupLlmProviderId {
  return llmProviderSchema.parse(provider) as SetupLlmProviderId;
}

function buildProfile(existing: OperatorProfile | null, provider: SetupLlmProviderId): OperatorProfile {
  return {
    schemaVersion: 1,
    locale: existing?.locale,
    llm: {
      ...existing?.llm,
      provider,
      sendScope: existing?.llm?.sendScope ?? 'changed',
    },
  };
}

export async function saveSetupLlmProfile(
  provider: SetupLlmProviderId,
  profilePath = defaultOperatorProfilePath(),
): Promise<string> {
  const existing = await loadOperatorProfile(profilePath);
  return saveOperatorProfile(buildProfile(existing, provider), profilePath);
}

export async function configureOperatorLlm(options: LlmSetupOptions): Promise<LlmSetupReport> {
  const provider = parseSetupProvider(options.provider);
  const inspect = await runLlmInspect({ provider, path: options.repositoryPath });
  const profilePath = options.profilePath ?? defaultOperatorProfilePath();
  const base: LlmSetupReport = {
    attempted: true,
    provider,
    inspectAvailable: inspect.exitCode === 0,
    inspectDetail: inspect.stderr.trim(),
    profilePath,
    profileWritten: false,
  };

  if (!options.saveProfile || !base.inspectAvailable) {
    return base;
  }

  await saveSetupLlmProfile(provider, profilePath);
  return {
    ...base,
    profileWritten: true,
  };
}

export function formatLlmSetupConsole(locale: ReportLocale, report: LlmSetupReport): string[] {
  if (!report.attempted || !report.provider) {
    return [];
  }

  const lines = [setupT(locale, 'setup.llm.title', { provider: report.provider })];
  if (report.inspectAvailable) {
    lines.push(setupT(locale, 'setup.llm.available'));
  } else {
    lines.push(setupT(locale, 'setup.llm.unavailable'));
    if (report.inspectDetail) {
      lines.push(report.inspectDetail);
    }
  }
  if (report.profileWritten && report.profilePath) {
    lines.push(setupT(locale, 'setup.llm.profileWritten', { path: report.profilePath }));
  }
  return lines;
}
