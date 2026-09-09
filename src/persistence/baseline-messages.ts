import { quoteCliArgument } from '../shared/cli-argument.js';

function baselineSaveCommand(repositoryPath: string): string {
  return `r3-doctor scan ${quoteCliArgument(repositoryPath)} --save-baseline`;
}

export function baselineDirtyWorktreeMessage(repositoryPath: string): string {
  return [
    'baseline save rejected: uncommitted changes in the repository.',
    `Commit or discard changes, then run: ${baselineSaveCommand(repositoryPath)}`,
    '(scan may have completed; only baseline was not saved)',
  ].join(' ');
}

export function baselineWorktreeChangedMessage(repositoryPath: string): string {
  return [
    'baseline save rejected: repository changed during scan.',
    `Commit or discard changes, then run: ${baselineSaveCommand(repositoryPath)}`,
    '(scan completed; only baseline was not saved)',
  ].join(' ');
}
