import type { ReportLocale } from '../i18n/locale.js';

import { setupT } from './messages.js';

export function buildNextSteps(
  locale: ReportLocale,
  repositoryPath: string,
  options: { skipLlm?: boolean; skipBaseline?: boolean; hasBaseline?: boolean },
): string[] {
  const target = repositoryPath === '.' ? '.' : repositoryPath;
  const steps = [
    setupT(locale, 'setup.next.check', { path: target }),
    setupT(locale, 'setup.next.scan', { path: target }),
  ];
  if (!options.skipBaseline && !options.hasBaseline) {
    steps.push(setupT(locale, 'setup.next.baseline', { path: target }));
  }
  if (!options.skipLlm) {
    steps.push(setupT(locale, 'setup.next.llm', { path: target }));
  }
  return steps;
}

export function formatNextStepsConsole(locale: ReportLocale, steps: string[]): string {
  return [
    setupT(locale, 'setup.next.title'),
    ...steps.map((step) => `- ${step}`),
  ].join('\n');
}
