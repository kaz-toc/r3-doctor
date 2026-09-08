import { DEFAULT_LOCALE, parseReportLocale, resolveLocale, type ReportLocale } from '../i18n/locale.js';
import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig } from '../shared/config.js';

export type SetupLocaleOptions = {
  localeFlag?: string;
  jsonMode?: boolean;
  existingConfigLocale?: ReportLocale;
};

export function inferLocaleFromEnvironment(): ReportLocale {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? '';
  return lang.startsWith('ja') ? 'ja' : DEFAULT_LOCALE;
}

export function resolveSetupLocale(options: SetupLocaleOptions): ReportLocale {
  if (options.localeFlag) {
    return parseReportLocale(options.localeFlag);
  }
  if (options.existingConfigLocale) {
    return options.existingConfigLocale;
  }
  return inferLocaleFromEnvironment();
}

export async function resolveCheckLocale(
  repositoryPath: string,
  localeFlag?: string,
): Promise<ReportLocale> {
  if (localeFlag) {
    return parseReportLocale(localeFlag);
  }
  try {
    const config = await loadConfig(repositoryPath, defaultLlmConfig);
    return resolveLocale(config, undefined);
  } catch {
    return inferLocaleFromEnvironment();
  }
}
