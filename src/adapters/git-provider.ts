import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/;

export type GitProvider = {
  listChangedFiles(repositoryPath: string, baseRef: string): Promise<string[]>;
  resolveRef(repositoryPath: string, ref: string): Promise<string>;
  resolveHeadCommit(repositoryPath: string): Promise<string | undefined>;
  inspectRepository(repositoryPath: string, analyzedPaths?: string[]): Promise<GitRepositoryState | undefined>;
};

export type GitRepositoryState = {
  rootPath: string;
  headSha: string;
  dirty: boolean;
  statusFingerprint: string;
};

function normalizeChangedFiles(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter((line) => SOURCE_FILE_PATTERN.test(line)))].sort();
}

async function runGit(repositoryPath: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', args, { cwd: repositoryPath });
  return stdout.split('\n');
}

async function listUntrackedFiles(repositoryPath: string): Promise<string[]> {
  try {
    const lines = await runGit(repositoryPath, ['ls-files', '--others', '--exclude-standard']);
    return normalizeChangedFiles(lines);
  } catch {
    return [];
  }
}

async function listChangedPaths(repositoryPath: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', [...args, '--name-status', '-z'], {
    cwd: repositoryPath,
    maxBuffer: 16 * 1024 * 1024,
  });
  const tokens = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const firstPath = tokens[index++];
    if (firstPath) paths.push(firstPath);
    if (status.startsWith('R') || status.startsWith('C')) {
      const secondPath = tokens[index++];
      if (secondPath) paths.push(secondPath);
    }
  }
  return normalizeChangedFiles(paths);
}

export class DefaultGitProvider implements GitProvider {
  async inspectRepository(
    repositoryPath: string,
    analyzedPaths: string[] = [],
  ): Promise<GitRepositoryState | undefined> {
    try {
      const repositoryRealPath = await realpath(repositoryPath);
      const { stdout: rootOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repositoryRealPath,
      });
      const rootPath = await realpath(rootOutput.trim());
      if (path.relative(repositoryRealPath, rootPath) !== '') {
        return undefined;
      }
      const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repositoryRealPath,
      });
      const { stdout: statusOutput } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
        { cwd: repositoryRealPath },
      );
      const { stdout: trackedOutput } = await execFileAsync('git', ['ls-files', '--cached', '-z'], {
        cwd: repositoryRealPath,
        maxBuffer: 16 * 1024 * 1024,
      });
      const trackedFiles = new Set(
        trackedOutput.split('\0').filter(Boolean).map((file) => file.replace(/\\/g, '/')),
      );
      const containsUntrackedAnalyzedFile = analyzedPaths.some(
        (file) => !trackedFiles.has(file.replace(/\\/g, '/')),
      );
      return {
        rootPath,
        headSha: headOutput.trim(),
        dirty: statusOutput.trim().length > 0 || containsUntrackedAnalyzedFile,
        statusFingerprint: createHash('sha256').update(statusOutput).digest('hex'),
      };
    } catch {
      return undefined;
    }
  }

  async listChangedFiles(repositoryPath: string, baseRef: string): Promise<string[]> {
    const collected = new Set<string>();

    const commands: string[][] = [
      ['diff', baseRef],
      ['diff', '--cached', baseRef],
      ['diff', `${baseRef}...HEAD`],
    ];

    for (const args of commands) {
      try {
        for (const changedPath of await listChangedPaths(repositoryPath, args)) {
          collected.add(changedPath);
        }
      } catch {
        continue;
      }
    }

    for (const line of await listUntrackedFiles(repositoryPath)) {
      collected.add(line);
    }

    return [...collected].sort();
  }

  async resolveRef(repositoryPath: string, ref: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repositoryPath,
    });
    return stdout.trim();
  }

  async resolveHeadCommit(repositoryPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
