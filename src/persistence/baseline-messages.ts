export function baselineDirtyWorktreeMessage(): string {
  return [
    'baseline save rejected: uncommitted changes in the repository.',
    'Commit or discard changes, then run: r3-doctor scan <path> --save-baseline',
    '(scan may have completed; only baseline was not saved)',
  ].join(' ');
}

export function baselineWorktreeChangedMessage(): string {
  return [
    'baseline save rejected: repository changed during scan.',
    'Commit or discard changes, then run: r3-doctor scan <path> --save-baseline',
    '(scan completed; only baseline was not saved)',
  ].join(' ');
}
