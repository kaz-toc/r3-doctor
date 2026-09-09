import path from 'node:path';

import { Command } from 'commander';

import { R3DoctorError } from '../shared/errors.js';
import { buildLlmCatalog } from '../semantic/llm/catalog.js';
import { formatLlmCatalogConsole, formatLlmCatalogJson } from '../semantic/llm/format.js';

const VALID_FORMATS = new Set(['console', 'json']);

function parseFormat(value: string): 'console' | 'json' {
  if (!VALID_FORMATS.has(value)) {
    throw new R3DoctorError(`invalid format: ${value}`);
  }
  return value as 'console' | 'json';
}

function getLlmCommand(program: Command): Command {
  const existing = program.commands.find((command) => command.name() === 'llm');
  if (existing) {
    return existing;
  }
  return program.command('llm').description('LLM provider utilities');
}

export function registerLlmListCommand(program: Command): void {
  getLlmCommand(program)
    .command('list')
    .description('list supported LLM providers')
    .option('--format <format>', 'console|json', 'console')
    .option('--inspect', 'probe provider availability via ACP initialize', false)
    .option('--provider <id>', 'limit --inspect to one provider (copilot|cursor|codex|claude|openai|anthropic)')
    .option('--path <path>', 'repository path for --inspect ACP runtime directory', process.cwd())
    .action(async (options: {
      format: string;
      inspect?: boolean;
      provider?: string;
      path: string;
    }) => {
      const format = parseFormat(options.format);
      const report = await buildLlmCatalog({
        inspect: Boolean(options.inspect),
        provider: options.provider,
        path: path.resolve(options.path),
      });
      const output = format === 'json'
        ? formatLlmCatalogJson(report)
        : formatLlmCatalogConsole(report);
      process.stdout.write(output);
    });
}
