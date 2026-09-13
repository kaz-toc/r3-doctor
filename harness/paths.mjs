import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class HarnessConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'HarnessConfigError';
  }
}

function outsideRoot(root, target) {
  const relation = relative(resolve(root), resolve(target));
  return relation === '..' || relation.startsWith('..' + sep) || isAbsolute(relation);
}

export function resolveRepositoryPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new HarnessConfigError('repository path must be a non-empty string');
  }
  if (isAbsolute(relativePath)) {
    throw new HarnessConfigError(`absolute repository path is prohibited: ${relativePath}`);
  }
  const target = resolve(root, relativePath);
  if (outsideRoot(root, target)) {
    throw new HarnessConfigError(`repository path escapes root: ${relativePath}`);
  }
  return target;
}

export function toRepositoryPath(root, absolutePath) {
  if (outsideRoot(root, absolutePath)) {
    throw new HarnessConfigError(`path is outside repository: ${absolutePath}`);
  }
  return relative(resolve(root), resolve(absolutePath)).split(sep).join('/');
}

export async function walkFiles(directory, { excludeSegments = [] } = {}) {
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (status.isSymbolicLink()) return [];
  if (!status.isDirectory()) return [];

  const files = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excludeSegments.includes(entry.name)) continue;
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  await visit(resolve(directory));
  return files.sort((left, right) => left.localeCompare(right));
}

