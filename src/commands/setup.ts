import path from 'node:path';

import { Command } from 'commander';

import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';
import { resolveSetupLocale } from '../setup/locale.js';
import { runInteractiveSetupChoices } from '../setup/interactive.js';
import type { SetupLlmProviderId } from '../setup/llm-providers.js';
import { formatSetupConsole, runSetup, setupExitCode } from '../setup/run.js';
import { setupReportSchema } from '../setup/schema.js';

function isInteractive(options: { yes?: boolean; json?: boolean }): boolean {
  return !options.yes && !options.json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .argument('[path]', 'repository path', '.')
    .option('--yes', 'non-interactive setup', false)
    .option('--json', 'emit JSON report')
    .option('--dry-run', 'detect and preview without writing config', false)
    .option('--force', 'overwrite existing config or write when baselines exist', false)
    .option('--locale <en|ja>', 'UI locale and config locale field')
    .option('--scan', 'run scan after setup (opt-in)', false)
    .option('--save-baseline', 'with --scan, save baseline after scan', false)
    .option('--skip-llm', 'skip LLM provider setup', false)
    .option('--skip-baseline', 'omit baseline next-step guidance', false)
    .option('--profile <path>', 'operator profile JSON (defaults to ~/.config/r3-doctor/profile.json)')
    .action(async (
      repoPath: string,
      options: {
        yes?: boolean;
        json?: boolean;
        dryRun?: boolean;
        force?: boolean;
        locale?: string;
        scan?: boolean;
        saveBaseline?: boolean;
        skipLlm?: boolean;
        skipBaseline?: boolean;
        profile?: string;
      },
    ) => {
      if (options.saveBaseline && !options.scan) {
        throw new R3DoctorError('setup --save-baseline requires --scan');
      }

      const repositoryPath = path.resolve(repoPath);
      let existingConfigLocale;
      try {
        const config = await loadConfig(repositoryPath, defaultLlmConfig);
        existingConfigLocale = config.locale;
      } catch {
        existingConfigLocale = undefined;
      }

      let locale = resolveSetupLocale({
        localeFlag: options.locale,
        jsonMode: options.json,
        nonInteractive: Boolean(options.yes || options.json),
        existingConfigLocale: options.locale ? undefined : existingConfigLocale,
      });

      let dryRun = Boolean(options.dryRun);
      let force = Boolean(options.force);
      let skipLlm = options.skipLlm;
      let skipBaseline = options.skipBaseline;
      let runScan = Boolean(options.scan);
      let saveBaseline = Boolean(options.saveBaseline);
      let configureLlm = false;
      let llmProvider: SetupLlmProviderId | undefined;
      let saveOperatorProfile = false;
      let llmModel: string | undefined;
      let llmInspectAvailable: boolean | undefined;
      const profilePath = options.profile ? path.resolve(options.profile) : undefined;

      if (isInteractive(options)) {
        const choices = await runInteractiveSetupChoices(repositoryPath, {
          dryRun: options.dryRun,
          force: options.force,
          skipLlm: options.skipLlm,
          skipBaseline: options.skipBaseline,
          profilePath,
        });
        locale = choices.locale;
        dryRun = choices.dryRun;
        force = choices.force;
        skipLlm = choices.skipLlm;
        skipBaseline = choices.skipBaseline;
        runScan = choices.runScan;
        saveBaseline = choices.saveBaseline;
        configureLlm = choices.configureLlm;
        llmProvider = choices.llmProvider;
        llmModel = choices.llmModel;
        saveOperatorProfile = choices.saveOperatorProfile;
        llmInspectAvailable = choices.configureLlm ? choices.llmInspectAvailable : undefined;
      } else if (!options.yes) {
        throw new R3DoctorError('setup requires a TTY or --yes for non-interactive mode');
      }

      if (options.json && !options.locale) {
        process.stderr.write('warning: --json without --locale defaults to en\n');
      }

      const report = await runSetup({
        repositoryPath,
        locale,
        yes: true,
        dryRun,
        force,
        skipLlm,
        skipBaseline,
        runScan,
        saveBaseline,
        configureLlm,
        llmProvider,
        llmModel,
        profilePath,
        saveOperatorProfile,
        llmInspectAvailable,
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
