import { catalogs, type MessageKey, type MessageParams } from './catalog.js';
import type { ReportLocale } from './locale.js';

function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}

export function t(locale: ReportLocale, key: MessageKey, params?: MessageParams): string {
  const template = catalogs[locale][key];
  return params ? interpolate(template, params) : template;
}

export function getScoreDisclaimer(locale: ReportLocale): string {
  return t(locale, 'disclaimer.score');
}

export type { MessageKey, MessageParams };
