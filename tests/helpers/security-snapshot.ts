import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SecurityPolicy } from '../../src/addons/security/types.js';
import type { RepositorySnapshot } from '../../src/intake/snapshot.js';
import { defaultConfig, defaultLlmConfig, type LlmConfig } from '../../src/shared/config.js';

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** In-memory snapshot so planner tests never read the live filesystem. */
export function securitySnapshot(
  files: Record<string, string>,
  overrides: Partial<RepositorySnapshot> = {},
): RepositorySnapshot {
  return {
    repositoryPath: '/repo',
    inputId: '0123456789abcdef',
    files: Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content]) => ({
        relativePath,
        absolutePath: path.posix.join('/repo', relativePath),
        extension: path.extname(relativePath),
        content,
        contentHash: sha256(content),
        nonBlankLines: content.split('\n').filter((line) => line.trim().length > 0).length,
      })),
    gitAvailable: false,
    gitDirty: false,
    analysisContextFingerprint: 'f'.repeat(64),
    truncated: false,
    intakeIssues: [],
    config: { ...defaultConfig },
    ...overrides,
  };
}

export function securityPolicy(
  overrides: Partial<SecurityPolicy> = {},
  llm: Partial<LlmConfig> = {},
): SecurityPolicy {
  return {
    mode: 'scan',
    scope: 'repository',
    required: false,
    llm: { ...defaultLlmConfig, enabled: true, provider: 'codex', ...llm },
    maxBatches: 4,
    maxTotalPromptBytes: 240_000,
    timeoutMs: 180_000,
    ...overrides,
  };
}

export const ORDERS_SOURCE = [
  "import { db } from './db';",
  "import { requireUser } from './auth';",
  "import helmet from 'helmet';",
  '',
  'export const LIMIT = 10;',
  'app.use(helmet());',
  '',
  'export async function getOrder(req, res) {',
  "  const order = await db.query('SELECT * FROM orders WHERE id = ' + req.params.id);",
  '  res.json(formatOrder(order));',
  '}',
  '',
  'function formatOrder(order) {',
  '  return { id: order.id };',
  '}',
  '',
  'export class OrderService {',
  '  constructor(repo) { this.repo = repo; }',
  '  async remove(id) { return this.repo.delete(id); }',
  '}',
  '',
  "router.post('/orders', requireUser, async (req, res) => {",
  "  res.json(await db.query('INSERT INTO orders VALUES (?)', [req.body]));",
  '});',
  '',
  'export async function dispatch(handlers, action, req) {',
  '  const mod = await import(action);',
  '  return handlers[action](req);',
  '}',
].join('\n');

export const AUTH_SOURCE = [
  'export function requireUser(req, res, next) {',
  '  if (!req.user) return res.status(401).end();',
  '  next();',
  '}',
].join('\n');

export const DB_SOURCE = 'export const db = { query: async (sql, values) => [] };\n';
