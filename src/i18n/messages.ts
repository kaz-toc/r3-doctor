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

const COUNT_MESSAGE_KEYS = {
  'format.remainingEvidence': {
    one: 'format.remainingEvidence.one',
    other: 'format.remainingEvidence.other',
  },
  'format.remainingClusters': {
    one: 'format.remainingClusters.one',
    other: 'format.remainingClusters.other',
  },
  'format.remainingPaths': {
    one: 'format.remainingPaths.one',
    other: 'format.remainingPaths.other',
  },
  'format.remainingInterventions': {
    one: 'format.remainingInterventions.one',
    other: 'format.remainingInterventions.other',
  },
} as const satisfies Record<string, { one: MessageKey; other: MessageKey }>;

export type CountMessageKey = keyof typeof COUNT_MESSAGE_KEYS;

export function tCount(locale: ReportLocale, key: CountMessageKey, count: number): string {
  const forms = COUNT_MESSAGE_KEYS[key];
  const templateKey = count === 1 ? forms.one : forms.other;
  return t(locale, templateKey, { count });
}

export function formatPathCount(locale: ReportLocale, count: number): string {
  const templateKey = count === 1 ? 'format.pathCount.one' : 'format.pathCount.other';
  return t(locale, templateKey, { count });
}

export function getScoreDisclaimer(locale: ReportLocale): string {
  return t(locale, 'disclaimer.score');
}

export type { MessageKey, MessageParams };
