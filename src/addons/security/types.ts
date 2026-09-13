import type { LlmConfig } from '../../shared/config.js';
import type {
  SecurityCoverage,
  SecurityFinding,
  SecurityRevision,
} from '../../schema/security-assessment.v1.js';

export type SecurityRelevance = NonNullable<SecurityFinding['relevance']>;

export type SecurityMode = 'scan' | 'diff';

export type SecurityScope = 'repository' | 'changed';

export type SecurityCliOptions = {
  security?: boolean;
  securityRequired?: boolean;
  dryRunSecurity?: boolean;
  securityScope?: SecurityScope;
};

export type SecurityPolicy = {
  mode: SecurityMode;
  scope: SecurityScope;
  required: boolean;
  llm: LlmConfig;
  maxBatches: number;
  maxTotalPromptBytes: number;
  timeoutMs: number;
};

export type SecurityDecision =
  | { kind: 'disabled'; required: false }
  | { kind: 'blocked'; required: boolean; reason: 'operator-consent-required' }
  | { kind: 'enabled'; required: boolean; policy: SecurityPolicy };

/** Internal only: carries source text and must never be serialized into a public assessment. */
export type SecuritySnippet = {
  snippetId: string;
  path: string;
  revision: SecurityRevision;
  startLine: number;
  endLine: number;
  content: string;
  /** SHA-256 of `content` as sent, which differs from the original text when values were masked. */
  contentHash: string;
  /** Absolute line numbers whose secret values were masked before sending. */
  redactedLines?: number[];
};

export type SecurityUnit = {
  unitId: string;
  path: string;
  revision: SecurityRevision;
  startLine: number;
  endLine: number;
  priority: number;
  relatedPaths: string[];
  /** Directly related units (dependency, caller, guard, or same-file reference), capped per unit. */
  relatedUnitIds: string[];
  limitations: string[];
  /** Symbol-based anchor such as `function:getOrder` or `method:Service.remove#window-2`. */
  anchor: string;
  relevance?: SecurityRelevance;
};

/** Internal only: the prompt contains source text. */
export type SecurityBatch = {
  batchId: string;
  units: SecurityUnit[];
  snippets: SecuritySnippet[];
  prompt: string;
  promptBytes: number;
};

export type SecurityPlan = {
  batches: SecurityBatch[];
  coverage: SecurityCoverage;
  reasons: string[];
  limitations: string[];
};

export type SecurityBatchResult = {
  batchId: string;
  evaluatedUnitIds: string[];
  incompleteUnitIds: string[];
  findings: SecurityFinding[];
  reasons: string[];
  invalidFindingCount: number;
};

export type SecurityLineRange = { startLine: number; endLine: number };

export type SecurityChange = {
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
  currentPath: string | null;
  basePath: string | null;
  current: SecurityLineRange | null;
  base: SecurityLineRange | null;
  /** Internal only: base-revision text used to plan removed code, never serialized. */
  baseContent: string | null;
  baseContentHash: string | null;
};

export type SecurityChangeContext = {
  status: 'complete' | 'partial' | 'unavailable';
  baseSha: string | null;
  changes: SecurityChange[];
  reasons: string[];
};
