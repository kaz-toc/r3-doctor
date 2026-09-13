import { readFile } from 'node:fs/promises';
import path from 'node:path';

const VALIDATION_GITIGNORE_LINE = '.r3-doctor/validation/';

export async function warnIfValidationNotGitignored(repositoryPath: string): Promise<string | null> {
  const gitignorePath = path.join(repositoryPath, '.gitignore');
  const contents = await readFile(gitignorePath, 'utf8').catch(() => null);
  if (contents === null) {
    return `validation hint: add "${VALIDATION_GITIGNORE_LINE}" to .gitignore so clean worktree recording keeps working`;
  }
  const lines = contents.split('\n').map((line) => line.trim());
  if (lines.some((line) => line === VALIDATION_GITIGNORE_LINE || line === '.r3-doctor/validation')) {
    return null;
  }
  return `validation hint: add "${VALIDATION_GITIGNORE_LINE}" to .gitignore so clean worktree recording keeps working`;
}
