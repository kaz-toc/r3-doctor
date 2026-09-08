import { t, type MessageKey } from '../i18n/messages.js';
import type { ReportLocale } from '../i18n/locale.js';

import type { BaselineSaveBlockReason } from './baseline-eligibility.js';

export type SetupMessageKey = Extract<
  MessageKey,
  `setup.${string}` | `check.${string}`
>;

export const BASELINE_BLOCKED_MESSAGE_KEYS: Record<
  BaselineSaveBlockReason,
  `setup.warn.baselineBlocked.${BaselineSaveBlockReason}`
> = {
  willWriteConfig: 'setup.warn.baselineBlocked.willWriteConfig',
  dirtyWorktree: 'setup.warn.baselineBlocked.dirtyWorktree',
};

export function quoteCliArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function setupT(locale: ReportLocale, key: SetupMessageKey, params?: Record<string, string | number>): string {
  return t(locale, key, params);
}
