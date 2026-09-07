import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { R3DoctorError } from '../shared/errors.js';
import { sanitizeExecutableSearchPath } from '../shared/executable-path.js';

const execFileAsync = promisify(execFile);

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/;
const GIT_ENV_KEYS = [
  'PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
] as const;

function gitEnvironment(repositoryPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  for (const key of GIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = sanitizeExecutableSearchPath(env.PATH, repositoryPath);
  return env;
}

export type GitProvider = {
  collectFileChurn(repositoryPath: string, churnDays: number): Promise<Map<string, number>>;
  listChangedFiles(repositoryPath: string, baseRef: string): Promise<string[]>;
  resolveRef(repositoryPath: string, ref: string): Promise<string>;
  resolveHeadCommit(repositoryPath: string): Promise<string | undefined>;
  inspectRepository(repositoryPath: string, analyzedPaths?: string[]): Promise<GitRepositoryState | undefined>;
};

function safeGitArgs(args: string[]): string[] {
  return ['-c', 'core.fsmonitor=false', ...args];
}

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
  const { stdout } = await execFileAsync('git', safeGitArgs(args), {
    cwd: repositoryPath,
    env: gitEnvironment(repositoryPath),
  });
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

export class DefaultGitProvider implements GitProvider {
  async collectFileChurn(repositoryPath: string, churnDays: number): Promise<Map<string, number>> {
    try {
      const lines = await runGit(repositoryPath, [
        'log',
        `--since=${churnDays} days ago`,
        '--name-only',
        '--pretty=format:',
      ]);
      const counts = new Map<string, number>();
      for (const line of lines) {
        const file = line.trim();
        if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
      }
      return counts;
    } catch {
      return new Map();
    }
  }

  async inspectRepository(
    repositoryPath: string,
    analyzedPaths: string[] = [],
  ): Promise<GitRepositoryState | undefined> {
    try {
      const repositoryRealPath = await realpath(repositoryPath);
      const { stdout: rootOutput } = await execFileAsync('git', safeGitArgs(['rev-parse', '--show-toplevel']), {
        cwd: repositoryRealPath,
        env: gitEnvironment(repositoryRealPath),
      });
      const rootPath = await realpath(rootOutput.trim());
      if (path.relative(repositoryRealPath, rootPath) !== '') {
        return undefined;
      }
      const { stdout: headOutput } = await execFileAsync('git', safeGitArgs(['rev-parse', '--verify', 'HEAD^{commit}']), {
        cwd: repositoryRealPath,
        env: gitEnvironment(repositoryRealPath),
      });
      const { stdout: statusOutput } = await execFileAsync(
        'git',
        safeGitArgs(['status', '--porcelain=v1', '--untracked-files=all', '--', '.']),
        { cwd: repositoryRealPath, env: gitEnvironment(repositoryRealPath) },
      );
      const { stdout: trackedOutput } = await execFileAsync('git', safeGitArgs(['ls-files', '--cached', '-z']), {
        cwd: repositoryRealPath,
        maxBuffer: 16 * 1024 * 1024,
        env: gitEnvironment(repositoryRealPath),
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
      ['diff', '--name-only', baseRef, '--'],
      ['diff', '--cached', '--name-only', baseRef, '--'],
      ['diff', '--name-only', `${baseRef}...HEAD`, '--'],
    ];

    for (const args of commands) {
      try {
        for (const line of await runGit(repositoryPath, args)) {
          if (SOURCE_FILE_PATTERN.test(line.trim())) {
            collected.add(line.trim());
          }
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
    if (ref.startsWith('-')) {
      throw new R3DoctorError('git ref must not start with a dash');
    }
    const { stdout } = await execFileAsync(
      'git',
      safeGitArgs(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
      {
        cwd: repositoryPath,
        env: gitEnvironment(repositoryPath),
      },
    );
    const objectId = stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) {
      throw new R3DoctorError('git ref did not resolve to a full commit object ID');
    }
    return objectId;
  }

  async resolveHeadCommit(repositoryPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', safeGitArgs(['rev-parse', 'HEAD']), {
        cwd: repositoryPath,
        env: gitEnvironment(repositoryPath),
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
