import {
  defaultOperatorProfilePath,
  loadOperatorProfile,
  saveOperatorProfile,
  type OperatorProfile,
} from '../operator/profile.js';
import type { ReportLocale } from '../i18n/locale.js';
import { resolveLlmRuntimeDirectory } from '../semantic/llm/runtime-directory.js';
import { runLlmInspect } from '../semantic/llm/inspect.js';
import type { LlmConfig } from '../shared/config.js';
import { llmProviderSchema } from '../shared/config.js';

import { setupT } from './messages.js';
import type { SetupLlmProviderId } from './llm-providers.js';

export type LlmSetupOptions = {
  locale: ReportLocale;
  repositoryPath: string;
  provider: SetupLlmProviderId;
  model?: string;
  saveProfile: boolean;
  profilePath?: string;
};

export type LlmSetupReport = {
  attempted: boolean;
  provider?: SetupLlmProviderId;
  model?: string;
  inspectAvailable: boolean;
  inspectDetail: string;
  profilePath?: string;
  profileWritten: boolean;
};

export type SaveSetupLlmProfileOptions = {
  model?: string;
  profilePath?: string;
};

function parseSetupProvider(provider: string): SetupLlmProviderId {
  return llmProviderSchema.parse(provider) as SetupLlmProviderId;
}

function buildProfile(
  existing: OperatorProfile | null,
  provider: SetupLlmProviderId,
  model?: string,
): OperatorProfile {
  const llm: Partial<LlmConfig> = {
    ...existing?.llm,
    provider,
    sendScope: existing?.llm?.sendScope ?? 'changed',
  };
  if (existing?.llm?.provider !== provider) {
    delete llm.executablePath;
  }
  const trimmedModel = model?.trim();
  if (trimmedModel) {
    llm.model = trimmedModel;
  } else {
    delete llm.model;
  }
  return {
    schemaVersion: 1,
    locale: existing?.locale,
    llm,
  };
}

export async function saveSetupLlmProfile(
  provider: SetupLlmProviderId,
  options: SaveSetupLlmProfileOptions | string = {},
): Promise<string> {
  const normalized = typeof options === 'string'
    ? { profilePath: options }
    : options;
  const profilePath = normalized.profilePath ?? defaultOperatorProfilePath();
  const existing = await loadOperatorProfile(profilePath);
  return saveOperatorProfile(buildProfile(existing, provider, normalized.model), profilePath);
}

export async function configureOperatorLlm(options: LlmSetupOptions): Promise<LlmSetupReport> {
  const provider = parseSetupProvider(options.provider);
  const inspect = await runLlmInspect({
    provider,
    path: resolveLlmRuntimeDirectory(),
  });
  const profilePath = options.profilePath ?? defaultOperatorProfilePath();
  const base: LlmSetupReport = {
    attempted: true,
    provider,
    model: options.model?.trim() || undefined,
    inspectAvailable: inspect.exitCode === 0,
    inspectDetail: inspect.stderr.trim(),
    profilePath,
    profileWritten: false,
  };

  if (!options.saveProfile || !base.inspectAvailable) {
    return base;
  }

  await saveSetupLlmProfile(provider, { model: options.model, profilePath });
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
