import path from 'node:path';

import { Command } from 'commander';

import { inspectLlmProvider, runLlmInspect } from '../semantic/llm/inspect.js';
import { getOrCreateLlmCommand } from './llm-command.js';

export type LlmInspectOptions = {
  provider?: string;
  path: string;
};

export type LlmInspectResult = {
  exitCode: 0 | 1 | 2;
  stderr: string;
  row?: import('../semantic/llm/types.js').LlmProviderInspectRow;
};

export { runLlmInspect };

export function registerLlmInspectCommand(program: Command): void {
  getOrCreateLlmCommand(program)
    .command('inspect')
    .description('inspect configured LLM provider availability')
    .option('--provider <id>', 'provider id (copilot|cursor|codex|claude|openai|anthropic)')
    .option('--path <path>', 'repository path used as ACP runtime directory', process.cwd())
    .action(async (options: { provider?: string; path: string }) => {
      const result = await inspectLlmProvider({
        provider: options.provider,
        path: path.resolve(options.path),
      });
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });
}
