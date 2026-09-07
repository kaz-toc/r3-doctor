import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from './errors.js';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function resolveSafeRepositoryFile(
  repositoryPath: string,
  configuredFile: string,
  label: string,
): Promise<string | undefined> {
  if (path.isAbsolute(configuredFile)) {
    throw new ConfigError(configuredFile, `${label} must be a relative repository path`);
  }

  const repositoryRealPath = await realpath(repositoryPath);
  const lexicalPath = path.resolve(repositoryRealPath, configuredFile);
  const relative = path.relative(repositoryRealPath, lexicalPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConfigError(configuredFile, `${label} escapes repository root`);
  }

  let component = repositoryRealPath;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    component = path.join(component, segment);
    let componentStat;
    try {
      componentStat = await lstat(component);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (componentStat.isSymbolicLink()) {
      throw new ConfigError(configuredFile, `${label} contains a symbolic link`);
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && !componentStat.isDirectory()) {
      throw new ConfigError(configuredFile, `${label} parent must be a directory`);
    }
    if (isFinal && !componentStat.isFile()) {
      throw new ConfigError(configuredFile, `${label} must resolve to a regular file`);
    }
  }

  const physicalPath = await realpath(lexicalPath);
  const physicalRelative = path.relative(repositoryRealPath, physicalPath);
  if (physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative)) {
    throw new ConfigError(configuredFile, `${label} escapes repository root`);
  }
  return physicalPath;
}
