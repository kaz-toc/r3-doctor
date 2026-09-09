import { Command } from 'commander';

export function getOrCreateLlmCommand(program: Command): Command {
  const existing = program.commands.find((command) => command.name() === 'llm');
  if (existing) {
    return existing;
  }
  return program.command('llm').description('LLM provider utilities');
}
