import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HarnessConfigError,
  resolveRepositoryPath,
} from './paths.mjs';

export { HarnessConfigError };

const ARRAY_FIELDS = [
  'sourceRoots',
  'sourceExtensions',
  'excludeSegments',
  'requiredDocuments',
  'projectChecks',
];

function requireUniqueStrings(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new HarnessConfigError(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new HarnessConfigError(`${field} contains a duplicate entry`);
  }
}

export function validateConfig(value, root) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessConfigError('configuration must be a JSON object');
  }
  if (value.schemaVersion !== 1) {
    throw new HarnessConfigError('schemaVersion must be 1');
  }
  for (const field of ARRAY_FIELDS) {
    requireUniqueStrings(value[field], field);
  }
  if (!Number.isInteger(value.maxNonBlankLines) || value.maxNonBlankLines < 1) {
    throw new HarnessConfigError('maxNonBlankLines must be a positive integer');
  }
  if (typeof value.regressionRoot !== 'string' || value.regressionRoot.length === 0) {
    throw new HarnessConfigError('regressionRoot must be a non-empty string');
  }
  if (value.sourceExtensions.some((extension) => !extension.startsWith('.') || extension.includes('/'))) {
    throw new HarnessConfigError('sourceExtensions entries must begin with a dot and contain no path separator');
  }
  if (value.excludeSegments.some((segment) => segment.includes('/') || segment.includes('\\'))) {
    throw new HarnessConfigError('excludeSegments entries must be path segments');
  }

  for (const path of [
    ...value.sourceRoots,
    value.regressionRoot,
    ...value.requiredDocuments,
    ...value.projectChecks,
  ]) {
    resolveRepositoryPath(root, path);
  }
  if (value.projectChecks.some((path) => !path.endsWith('.mjs'))) {
    throw new HarnessConfigError('projectChecks entries must be .mjs modules');
  }

  return Object.freeze({
    ...value,
    sourceRoots: Object.freeze([...value.sourceRoots]),
    sourceExtensions: Object.freeze([...value.sourceExtensions]),
    excludeSegments: Object.freeze([...value.excludeSegments]),
    requiredDocuments: Object.freeze([...value.requiredDocuments]),
    projectChecks: Object.freeze([...value.projectChecks]),
  });
}

export async function loadConfig(root = process.cwd()) {
  const path = join(root, 'harness.config.json');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new HarnessConfigError(`cannot read harness.config.json: ${error.message}`, { cause: error });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new HarnessConfigError(`invalid harness.config.json: ${error.message}`, { cause: error });
  }
  return validateConfig(value, root);
}

