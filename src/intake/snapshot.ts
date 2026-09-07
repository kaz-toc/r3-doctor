import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { LlmConfig, R3DoctorConfig } from '../shared/config.js';
import {
  configSchema,
  defaultConfig,
  defaultLlmConfig,
  normalizeConfig,
  repositoryConfigSchema,
} from '../shared/config.js';
import { ConfigError, IntakeError } from '../shared/errors.js';
import { ASSESSMENT_CONTRACT_VERSION } from '../schema/report.v1.js';
import { getRegisteredExtensions } from '../plugins/language-extensions.js';
import { DefaultGitProvider } from '../adapters/git-provider.js';
import { analysisContextFingerprint } from './analysis-context.js';
import { readFileWithinByteLimit } from '../shared/bounded-file.js';

const REPOSITORY_CONFIG_MAX_BYTES = 1_048_576;
const GLOB_EVALUATION_MAX_OPERATIONS = 10_000_000;
const REPOSITORY_WALK_MAX_ENTRIES = 100_000;

type GlobToken = '*' | '**' | '?' | string;
type CompiledExcludePattern = Readonly<{
  segment?: string;
  tokens?: readonly GlobToken[];
}>;
type IntakeWorkBudget = { globOperations: number; visitedEntries: number };

export type SourceFile = {
  relativePath: string;
  absolutePath: string;
  extension: string;
  content: string;
  contentHash: string;
  nonBlankLines: number;
};

export type IntakeIssue = {
  kind: 'unreadable-file' | 'missing-unit-root' | 'truncated';
  path: string;
  message: string;
};

export type RepositorySnapshot = {
  repositoryPath: string;
  unitId?: string;
  inputId: string;
  files: SourceFile[];
  gitAvailable: boolean;
  sourceCommitSha?: string;
  gitDirty: boolean;
  gitStatusFingerprint?: string;
  analysisContextFingerprint: string;
  truncated: boolean;
  intakeIssues: IntakeIssue[];
  config: R3DoctorConfig;
};

function countNonBlankLines(content: string): number {
  return content.split('\n').filter((line) => line.trim().length > 0).length;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function compileExcludePattern(pattern: string): CompiledExcludePattern {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
    return { segment: normalizedPattern };
  }
  const tokens: GlobToken[] = [];

  for (let index = 0; index < normalizedPattern.length;) {
    const character = normalizedPattern[index]!;
    if (character === '*') {
      let next = index + 1;
      while (normalizedPattern[next] === '*') next += 1;
      tokens.push(next - index >= 2 ? '**' : '*');
      index = next;
      continue;
    }
    tokens.push(character);
    index += 1;
  }

  return { tokens };
}

function matchGlob(relativePath: string, tokens: readonly GlobToken[], budget: IntakeWorkBudget): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const operationCost = tokens.length * (normalized.length + 1);
  budget.globOperations += operationCost;
  if (budget.globOperations > GLOB_EVALUATION_MAX_OPERATIONS) {
    throw new IntakeError('exclude glob evaluation budget exceeded');
  }

  let reachable = new Uint8Array(normalized.length + 1);
  reachable[0] = 1;

  for (const token of tokens) {
    const next = new Uint8Array(normalized.length + 1);
    if (token === '*' || token === '**') {
      for (let index = 0; index <= normalized.length; index += 1) {
        if (reachable[index]) next[index] = 1;
        if (index < normalized.length && next[index] && (token === '**' || normalized[index] !== '/')) {
          next[index + 1] = 1;
        }
      }
    } else {
      for (let index = 0; index < normalized.length; index += 1) {
        if (reachable[index] && (token === '?' ? normalized[index] !== '/' : normalized[index] === token)) {
          next[index + 1] = 1;
        }
      }
    }
    reachable = next;
  }

  return reachable[normalized.length] === 1;
}

function createExclusionMatcher(
  exclude: string[],
  budget: IntakeWorkBudget,
): (relativePath: string) => boolean {
  const compiled = exclude.map(compileExcludePattern);
  return (relativePath) => {
    const segments = relativePath.replace(/\\/g, '/').split('/');
    return compiled.some((pattern) => pattern.tokens
      ? matchGlob(relativePath, pattern.tokens, budget)
      : segments.includes(pattern.segment ?? ''));
  };
}

export function isExcluded(relativePath: string, exclude: string[]): boolean {
  return createExclusionMatcher(exclude, { globOperations: 0, visitedEntries: 0 })(relativePath);
}

function resolveUnitRoot(repositoryPath: string, root: string): string {
  const resolved = path.resolve(repositoryPath, root);
  const relative = path.relative(repositoryPath, resolved);
  if (relative.startsWith('..') || path.isAbsolute(root)) {
    throw new IntakeError(`unit root escapes repository: ${root}`);
  }
  return resolved;
}

async function walkFiles(
  repositoryPath: string,
  current: string,
  isPathExcluded: (relativePath: string) => boolean,
  extensions: Set<string>,
  maxFiles: number,
  collected: SourceFile[],
  issues: IntakeIssue[],
  workBudget: IntakeWorkBudget,
): Promise<boolean> {
  if (collected.length >= maxFiles) {
    return true;
  }

  const { readdir, lstat } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    throw new IntakeError(`unit root is missing or unreadable: ${path.relative(repositoryPath, current) || '.'}`);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (collected.length >= maxFiles) {
      return true;
    }

    workBudget.visitedEntries += 1;
    if (workBudget.visitedEntries > REPOSITORY_WALK_MAX_ENTRIES) {
      throw new IntakeError(`repository walk exceeded ${REPOSITORY_WALK_MAX_ENTRIES} entry limit`);
    }
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(repositoryPath, absolutePath);

    if (isPathExcluded(relativePath)) {
      continue;
    }

    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      continue;
    }

    if (stat.isDirectory()) {
      const truncated = await walkFiles(
        repositoryPath,
        absolutePath,
        isPathExcluded,
        extensions,
        maxFiles,
        collected,
        issues,
        workBudget,
      );
      if (truncated) {
        return true;
      }
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name);
    if (!extensions.has(extension)) {
      continue;
    }

    try {
      const content = await readFile(absolutePath, 'utf8');
      collected.push({
        relativePath,
        absolutePath,
        extension,
        content,
        contentHash: hashContent(content),
        nonBlankLines: countNonBlankLines(content),
      });
    } catch {
      issues.push({
        kind: 'unreadable-file',
        path: relativePath,
        message: 'file could not be read',
      });
    }
  }

  return false;
}

export function computeInputId(unitId: string | undefined, files: SourceFile[], config: R3DoctorConfig): string {
  const hash = createHash('sha256');
  hash.update(String(ASSESSMENT_CONTRACT_VERSION));
  hash.update(JSON.stringify(normalizeConfig(config)));
  hash.update(unitId ?? '');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update(file.contentHash);
  }
  return hash.digest('hex').slice(0, 16);
}

export async function loadConfig(
  repositoryPath: string,
  llmConfig: LlmConfig = defaultLlmConfig,
): Promise<R3DoctorConfig> {
  const configPath = path.join(repositoryPath, 'r3-doctor.config.json');
  try {
    await access(configPath);
  } catch {
    return normalizeConfig({ ...defaultConfig, llm: llmConfig });
  }

  try {
    const raw = await readFileWithinByteLimit(configPath, REPOSITORY_CONFIG_MAX_BYTES, 'repository config');
    const repositoryConfig = repositoryConfigSchema.parse(JSON.parse(raw));
    return configSchema.parse({ ...repositoryConfig, llm: llmConfig });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(configPath, reason);
  }
}

export async function createRepositorySnapshot(
  repositoryPath: string,
  unitId?: string,
  llmConfig: LlmConfig = defaultLlmConfig,
): Promise<RepositorySnapshot> {
  const resolved = path.resolve(repositoryPath);
  try {
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      throw new IntakeError(`repository path is not a directory: ${resolved}`);
    }
  } catch (error) {
    if (error instanceof IntakeError) {
      throw error;
    }
    throw new IntakeError(`repository path does not exist: ${resolved}`);
  }

  const config = await loadConfig(resolved, llmConfig);
  const unit = unitId ? config.units.find((entry) => entry.id === unitId) : undefined;
  if (unitId && !unit) {
    throw new IntakeError(`unknown unit: ${unitId}`);
  }

  const extensions = getRegisteredExtensions();
  const gitProvider = new DefaultGitProvider();
  const gitBefore = await gitProvider.inspectRepository(resolved);
  const roots = unit ? unit.roots.map((root) => resolveUnitRoot(resolved, root)) : [resolved];
  const files: SourceFile[] = [];
  const intakeIssues: IntakeIssue[] = [];
  const workBudget: IntakeWorkBudget = { globOperations: 0, visitedEntries: 0 };
  const isPathExcluded = createExclusionMatcher(config.exclude, workBudget);
  let truncated = false;

  for (const root of roots) {
    const rootTruncated = await walkFiles(
      resolved,
      root,
      isPathExcluded,
      extensions,
      config.maxFiles,
      files,
      intakeIssues,
      workBudget,
    );
    truncated = truncated || rootTruncated;
  }

  if (truncated) {
    intakeIssues.push({
      kind: 'truncated',
      path: resolved,
      message: `file collection reached maxFiles=${config.maxFiles}`,
    });
  }

  const uniqueFiles = [...new Map(files.map((file) => [file.relativePath, file])).values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  const gitAfter = await gitProvider.inspectRepository(
    resolved,
    uniqueFiles.map((file) => file.relativePath),
  );
  if (
    (gitBefore === undefined) !== (gitAfter === undefined) ||
    (gitBefore && gitAfter && (
      gitBefore.rootPath !== gitAfter.rootPath ||
      gitBefore.headSha !== gitAfter.headSha ||
      gitBefore.statusFingerprint !== gitAfter.statusFingerprint
    ))
  ) {
    throw new IntakeError('Git repository state changed during repository intake');
  }
  const gitAvailable = gitAfter !== undefined;

  return {
    repositoryPath: resolved,
    unitId,
    inputId: computeInputId(unitId, uniqueFiles, config),
    files: uniqueFiles,
    gitAvailable,
    sourceCommitSha: gitAfter?.headSha,
    gitDirty: gitAfter?.dirty ?? false,
    gitStatusFingerprint: gitAfter?.statusFingerprint,
    analysisContextFingerprint: analysisContextFingerprint(config, unitId, gitAvailable),
    truncated,
    intakeIssues,
    config,
  };
}
