import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type { ReportLocale } from '../i18n/locale.js';
import { DEFAULT_LOCALE, parseReportLocale } from '../i18n/locale.js';

export type SetupPromptAdapter = {
  selectLocale(suggested: ReportLocale): Promise<ReportLocale>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  close(): Promise<void>;
};

function parseYesNo(value: string, initial?: boolean): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' && initial !== undefined) {
    return initial;
  }
  if (['y', 'yes', 'ja'].includes(normalized)) {
    return true;
  }
  if (['n', 'no'].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function createReadlinePrompts(): SetupPromptAdapter {
  const rl = createInterface({ input, output });

  return {
    async selectLocale(suggested: ReportLocale): Promise<ReportLocale> {
      const defaultLabel = suggested;
      for (;;) {
        const answer = await rl.question(`Language / 言語 [en/ja] (default: ${defaultLabel}): `);
        const trimmed = answer.trim();
        if (trimmed === '') {
          return suggested;
        }
        try {
          return parseReportLocale(trimmed);
        } catch {
          output.write('Enter en or ja.\n');
        }
      }
    },

    async confirm(message: string, initial = true): Promise<boolean> {
      const suffix = initial ? 'Y/n' : 'y/N';
      for (;;) {
        const answer = await rl.question(`${message} [${suffix}] `);
        const parsed = parseYesNo(answer, initial);
        if (parsed !== undefined) {
          return parsed;
        }
        output.write('Enter y or n.\n');
      }
    },

    async close(): Promise<void> {
      rl.close();
    },
  };
}

export function suggestedInteractiveLocale(): ReportLocale {
  const lang = process.env.LANG ?? process.env.LC_ALL ?? '';
  return lang.startsWith('ja') ? 'ja' : DEFAULT_LOCALE;
}

export async function createSetupPrompts(): Promise<SetupPromptAdapter> {
  if (process.env.R3_DOCTOR_SETUP_PROMPTS === 'readline') {
    return createReadlinePrompts();
  }
  try {
    const clack = await import('@clack/prompts');
    if (!input.isTTY || !output.isTTY) {
      return createReadlinePrompts();
    }
    return {
      async selectLocale(suggested: ReportLocale): Promise<ReportLocale> {
        const value = await clack.select({
          message: 'Language / 言語',
          options: [
            { value: 'en' as const, label: 'English' },
            { value: 'ja' as const, label: '日本語' },
          ],
          initialValue: suggested,
        });
        if (clack.isCancel(value)) {
          throw new Error('setup cancelled');
        }
        return value;
      },
      async confirm(message: string, initial = true): Promise<boolean> {
        const value = await clack.confirm({ message, initialValue: initial });
        if (clack.isCancel(value)) {
          throw new Error('setup cancelled');
        }
        return value;
      },
      async close(): Promise<void> {
        // clack manages its own lifecycle
      },
    };
  } catch {
    return createReadlinePrompts();
  }
}
