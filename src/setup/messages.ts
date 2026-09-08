import { t, type MessageKey } from '../i18n/messages.js';
import type { ReportLocale } from '../i18n/locale.js';

export type SetupMessageKey = Extract<
  MessageKey,
  `setup.${string}` | `check.${string}`
>;

export function setupT(locale: ReportLocale, key: SetupMessageKey, params?: Record<string, string | number>): string {
  return t(locale, key, params);
}
