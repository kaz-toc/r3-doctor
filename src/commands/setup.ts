import path from 'node:path';

import { Command } from 'commander';

import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';
import { resolveSetupLocale } from '../setup/locale.js';
import { formatSetupConsole, runSetup, setupExitCode } from '../setup/run.js';
import { setupReportSchema } from '../setup/schema.js';

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .argument('[path]', 'repository path', '.')
    .option('--yes', 'non-interactive setup', false)
    .option('--json', 'emit JSON report')
    .option('--dry-run', 'detect and preview without writing config', false)
    .option('--force', 'overwrite existing config or write when baselines exist', false)
    .option('--locale <en|ja>', 'UI locale and config locale field')
    .option('--skip-llm', 'omit LLM next-step guidance', false)
    .option('--skip-baseline', 'omit baseline next-step guidance', false)
    .action(async (
      repoPath: string,
      options: {
        yes?: boolean;
        json?: boolean;
        dryRun?: boolean;
        force?: boolean;
        locale?: string;
        skipLlm?: boolean;
        skipBaseline?: boolean;
      },
    ) => {
      if (!options.yes) {
        throw new R3DoctorError('setup requires --yes in non-interactive mode (TTY wizard arrives in Phase 1b)');
      }

      const repositoryPath = path.resolve(repoPath);
      let existingConfigLocale;
      try {
        const config = await loadConfig(repositoryPath, defaultLlmConfig);
        existingConfigLocale = config.locale;
      } catch {
        existingConfigLocale = undefined;
      }

      const locale = resolveSetupLocale({
        localeFlag: options.locale,
        jsonMode: options.json,
        existingConfigLocale,
      });

      if (options.json && !options.locale) {
        process.stderr.write('warning: --json without --locale defaults UI locale from environment\n');
      }

      const report = await runSetup({
        repositoryPath,
        locale,
        yes: true,
        dryRun: Boolean(options.dryRun),
        force: Boolean(options.force),
        skipLlm: options.skipLlm,
        skipBaseline: options.skipBaseline,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(setupReportSchema.parse(report), null, 2)}\n`);
      } else {
        process.stdout.write(formatSetupConsole(report));
      }

      const exitCode = setupExitCode(report);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });
}
