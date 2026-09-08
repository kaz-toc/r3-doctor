import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../intake/snapshot.js';
import { defaultLlmConfig, repositoryConfigSchema, type RepositoryConfig } from '../shared/config.js';
import { atomicWriteFile } from '../shared/atomic-write.js';
import { ConfigError } from '../shared/errors.js';

export const CONFIG_FILE_NAME = 'r3-doctor.config.json';

async function assertSafeConfigPath(repositoryPath: string): Promise<string> {
  const resolvedInput = path.resolve(repositoryPath);
  const inputStat = await lstat(resolvedInput);
  if (inputStat.isSymbolicLink()) {
    throw new ConfigError(CONFIG_FILE_NAME, 'repository root must not be a symbolic link');
  }

  const repositoryRealPath = await realpath(resolvedInput);
  const rootStat = await lstat(repositoryRealPath);
  if (rootStat.isSymbolicLink()) {
    throw new ConfigError(CONFIG_FILE_NAME, 'repository root must not be a symbolic link');
  }

  const configPath = path.join(repositoryRealPath, CONFIG_FILE_NAME);
  const configStat = await lstat(configPath).catch(() => null);
  if (configStat?.isSymbolicLink()) {
    throw new ConfigError(CONFIG_FILE_NAME, 'config path must not be a symbolic link');
  }

  return configPath;
}

export async function writeRepositoryConfig(
  repositoryPath: string,
  config: RepositoryConfig,
): Promise<{ configPath: string }> {
  const parsed = repositoryConfigSchema.parse(config);
  const configPath = await assertSafeConfigPath(path.resolve(repositoryPath));
  const content = `${JSON.stringify(parsed, null, 2)}\n`;

  await atomicWriteFile(configPath, content, async () => {
    await assertSafeConfigPath(path.resolve(repositoryPath));
  });

  await loadConfig(path.resolve(repositoryPath), defaultLlmConfig);
  return { configPath };
}
