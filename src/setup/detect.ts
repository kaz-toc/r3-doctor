import { access, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { repositoryConfigSchema, type RepositoryConfig } from '../shared/config.js';

export type DetectResult = {
  workspaces: string[];
  suggestedExclude: string[];
  hasGitignore: boolean;
  proposedConfig: RepositoryConfig;
};

const COMMON_IGNORED = ['node_modules', 'dist', 'build', 'coverage', '.git', '.r3-doctor'] as const;

const WORKSPACE_GLOBS = ['packages/*', 'apps/*', 'libs/*'] as const;

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function detectRepository(repositoryPath: string, locale: 'en' | 'ja'): Promise<DetectResult> {
  const resolved = path.resolve(repositoryPath);
  const exclude = new Set<string>(COMMON_IGNORED);
  const workspaces: string[] = [];

  const packageJson = await readJsonFile(path.join(resolved, 'package.json'));
  const workspacesField = packageJson?.workspaces;
  if (Array.isArray(workspacesField)) {
    for (const entry of workspacesField) {
      if (typeof entry === 'string') {
        workspaces.push(entry);
      }
    }
  } else if (
    typeof workspacesField === 'object'
    && workspacesField !== null
    && Array.isArray((workspacesField as { packages?: unknown }).packages)
  ) {
    for (const entry of (workspacesField as { packages: unknown[] }).packages) {
      if (typeof entry === 'string') {
        workspaces.push(entry);
      }
    }
  }

  for (const glob of WORKSPACE_GLOBS) {
    const base = glob.replace('/*', '');
    try {
      const entries = await readdir(path.join(resolved, base));
      if (entries.length > 0) {
        workspaces.push(glob);
      }
    } catch {
      // missing directory
    }
  }

  const hasGitignore = await access(path.join(resolved, '.gitignore'))
    .then(() => true)
    .catch(() => false);

  if (hasGitignore) {
    try {
      const gitignore = await readFile(path.join(resolved, '.gitignore'), 'utf8');
      for (const line of gitignore.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const normalized = trimmed.replace(/^\//, '').replace(/\/$/, '');
        if (normalized && !normalized.includes('*') && COMMON_IGNORED.includes(normalized as typeof COMMON_IGNORED[number])) {
          exclude.add(normalized);
        }
      }
    } catch {
      // ignore unreadable .gitignore
    }
  }

  const suggestedExclude = uniqueSorted([...exclude]);

  const proposedConfig = repositoryConfigSchema.parse({
    schemaVersion: 1,
    locale,
    exclude: suggestedExclude,
  });

  return {
    workspaces: uniqueSorted(workspaces),
    suggestedExclude,
    hasGitignore,
    proposedConfig,
  };
}

export async function configFileExists(repositoryPath: string): Promise<boolean> {
  try {
    await access(path.join(path.resolve(repositoryPath), 'r3-doctor.config.json'));
    return true;
  } catch {
    return false;
  }
}

export async function countBaselineEntries(repositoryPath: string, baselineDir: string): Promise<number> {
  const dirPath = path.join(path.resolve(repositoryPath), baselineDir);
  try {
    const stat = await lstat(dirPath);
    if (!stat.isDirectory()) {
      return 0;
    }
    const entries = await readdir(dirPath);
    return entries.filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
