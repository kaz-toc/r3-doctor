import type { LlmConfig } from '../../shared/config.js';
import type {
  SecurityCoverage,
  SecurityFinding,
  SecurityRevision,
} from '../../schema/security-assessment.v1.js';

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
  contentHash: string;
};

export type SecurityUnit = {
  unitId: string;
  path: string;
  revision: SecurityRevision;
  startLine: number;
  endLine: number;
  priority: number;
  relatedPaths: string[];
  limitations: string[];
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
