import { reportLocaleSchema, type R3DoctorConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';

export type ReportLocale = 'en' | 'ja';

export const DEFAULT_LOCALE: ReportLocale = 'en';

export function resolveLocale(
  config: Pick<R3DoctorConfig, 'locale'>,
  override?: ReportLocale,
): ReportLocale {
  if (override) {
    return override;
  }
  return config.locale ?? DEFAULT_LOCALE;
}

export function parseReportLocale(value: string): ReportLocale {
  const result = reportLocaleSchema.safeParse(value);
  if (!result.success) {
    throw new R3DoctorError(`invalid locale: ${value}`);
  }
  return result.data;
}
