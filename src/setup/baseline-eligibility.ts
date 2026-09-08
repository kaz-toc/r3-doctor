import { DefaultGitProvider } from '../adapters/git-provider.js';

export type BaselineSaveBlockReason = 'willWriteConfig' | 'dirtyWorktree';

export type BaselineSaveEligibility = {
  eligible: boolean;
  reason: BaselineSaveBlockReason | null;
};

export async function assessBaselineSaveEligibility(
  repositoryPath: string,
  options: { willWriteConfig: boolean },
): Promise<BaselineSaveEligibility> {
  if (options.willWriteConfig) {
    return { eligible: false, reason: 'willWriteConfig' };
  }

  const gitState = await new DefaultGitProvider().inspectRepository(repositoryPath);
  if (!gitState) {
    return { eligible: true, reason: null };
  }
  if (gitState.dirty) {
    return { eligible: false, reason: 'dirtyWorktree' };
  }

  return { eligible: true, reason: null };
}
