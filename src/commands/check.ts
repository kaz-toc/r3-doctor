import path from 'node:path';

import { Command } from 'commander';

import { resolveCheckLocale } from '../setup/locale.js';
import { checkExitCode, formatCheckConsole, runCheck } from '../setup/readiness.js';
import { checkReportSchema } from '../setup/schema.js';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .argument('[path]', 'repository path', '.')
    .option('--json', 'emit JSON report')
    .option('--locale <en|ja>', 'human output locale')
    .option('--llm', 'inspect default LLM provider availability')
    .option('--llm-provider <id>', 'provider for --llm')
    .action(async (
      repoPath: string,
      options: { json?: boolean; locale?: string; llm?: boolean; llmProvider?: string },
    ) => {
      const repositoryPath = path.resolve(repoPath);
      const locale = await resolveCheckLocale(repositoryPath, options.locale);
      const report = await runCheck({
        repositoryPath,
        locale,
        inspectLlm: options.llm,
        llmProvider: options.llmProvider,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(checkReportSchema.parse(report), null, 2)}\n`);
      } else {
        process.stdout.write(formatCheckConsole(report));
      }

      const exitCode = checkExitCode(report);
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });
}
