import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { registerLlmInspectCommand } from '../../src/commands/llm-inspect.js';
import { registerLlmListCommand } from '../../src/commands/llm-list.js';

function commandNames(program: Command): string[] {
  const llm = program.commands.find((command) => command.name() === 'llm');
  if (!llm) {
    return [];
  }
  return llm.commands.map((command) => command.name());
}

describe('llm command registration', () => {
  it('registers inspect and list regardless of registration order', () => {
    const inspectFirst = new Command();
    registerLlmInspectCommand(inspectFirst);
    registerLlmListCommand(inspectFirst);
    expect(commandNames(inspectFirst)).toEqual(['inspect', 'list']);

    const listFirst = new Command();
    registerLlmListCommand(listFirst);
    registerLlmInspectCommand(listFirst);
    expect(commandNames(listFirst)).toEqual(['list', 'inspect']);
  });
});
