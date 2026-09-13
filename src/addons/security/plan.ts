import { createHash } from 'node:crypto';

import type { RepositorySnapshot } from '../../intake/snapshot.js';
import type { SecurityCoverage } from '../../schema/security-assessment.v1.js';

import {
  analyzeSecuritySources,
  securityPathScopeReason,
  securitySourceKey,
  type SecurityBaseSource,
  type SecuritySourceAnalysis,
} from './context.js';
import { filterSecuritySnippet, type OutboundFilterResult } from './outbound-filter.js';
import { buildSecurityPrompt, securitySnippetBlock, securityUnitLine, snippetIdForUnitId } from './prompt.js';
import type {
  SecurityBatch,
  SecurityChange,
  SecurityChangeContext,
  SecurityPlan,
  SecurityPolicy,
  SecuritySnippet,
  SecurityUnit,
} from './types.js';

export const SECURITY_UNITS_PER_BATCH = 8;

const RELATION_LIMITATION =
  'Related code is resolved from static imports and simple same-file references only; dynamic imports, computed calls, and external middleware are not followed.';
const CHANGED_SEND_SCOPE_LIMITATION =
  'Related code outside the changed files was not sent because the operator send scope is changed.';

export type SecurityPlanInput = {
  snapshot: RepositorySnapshot;
  policy: SecurityPolicy;
  changes?: SecurityChangeContext;
};

type DraftBatch = SecurityBatch & { snippetIds: Set<string> };

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function increment(counts: Record<string, number>, reason: string, amount = 1): void {
  if (amount > 0) counts[reason] = (counts[reason] ?? 0) + amount;
}

function emptyCoverage(intakeTruncated: boolean): SecurityCoverage {
  return {
    eligibleFiles: 0,
    selectedFiles: 0,
    evaluatedFiles: 0,
    eligibleUnits: 0,
    selectedUnits: 0,
    evaluatedUnits: 0,
    excludedByReason: {},
    incompleteByReason: {},
    intakeTruncated,
  };
}

function overlaps(unit: SecurityUnit, range: SecurityChange['current']): boolean {
  return range !== null && unit.startLine <= range.endLine && range.startLine <= unit.endLine;
}

function isDirectChange(unit: SecurityUnit, change: SecurityChange): boolean {
  return unit.revision === 'current'
    ? change.currentPath === unit.path && overlaps(unit, change.current)
    : change.basePath === unit.path && overlaps(unit, change.base);
}

function compareByPriority(left: SecurityUnit, right: SecurityUnit): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.revision !== right.revision) return left.revision < right.revision ? -1 : 1;
  return left.startLine - right.startLine;
}

function baseSourcesOf(changes: SecurityChangeContext | undefined): SecurityBaseSource[] {
  return (changes?.changes ?? []).flatMap((change) =>
    change.basePath && change.baseContent !== null ? [{ path: change.basePath, content: change.baseContent }] : []);
}

function selectScope(analysis: SecuritySourceAnalysis, changes: SecurityChangeContext | undefined) {
  if (!changes) {
    return { primary: analysis.units, oversized: analysis.oversized, excludedByReason: analysis.excludedByReason };
  }
  const excludedByReason: Record<string, number> = {};
  for (const change of changes.changes) {
    const reason = securityPathScopeReason(change.currentPath ?? change.basePath ?? '');
    if (reason) increment(excludedByReason, reason);
  }
  const changedKeys = new Set(changes.changes.flatMap((change) => [
    ...(change.currentPath ? [securitySourceKey('current', change.currentPath)] : []),
    ...(change.basePath ? [securitySourceKey('base', change.basePath)] : []),
  ]));
  return {
    primary: analysis.units
      .filter((unit) => changes.changes.some((change) => isDirectChange(unit, change)))
      .map((unit): SecurityUnit => ({ ...unit, relevance: 'direct-change' })),
    oversized: analysis.oversized.filter((source) => changedKeys.has(securitySourceKey(source.revision, source.path))),
    excludedByReason,
  };
}

/**
 * Plans bounded provider batches: units are ordered by priority, path, revision, and line, then placed
 * first-fit while reserving per-request bytes, total bytes across requests (re-sent snippets included),
 * unique sent paths, units per batch, and batch count. Units that do not fit stay in coverage as incomplete.
 */
export function buildSecurityPlan(input: SecurityPlanInput): SecurityPlan {
  const { snapshot, policy, changes } = input;
  if (!changes && (policy.scope === 'changed' || policy.llm.sendScope === 'changed')) {
    return { batches: [], coverage: emptyCoverage(snapshot.truncated), reasons: ['base-required'], limitations: [] };
  }

  const reasons = changes && changes.status !== 'complete' ? [`change-context-${changes.status}`] : [];
  const analysis = analyzeSecuritySources(snapshot, baseSourcesOf(changes));
  const { primary, oversized, excludedByReason } = selectScope(analysis, changes);
  const unitsById = new Map(analysis.units.map((unit) => [unit.unitId, unit]));
  const allowedKeys = changes && policy.llm.sendScope === 'changed'
    ? new Set(changes.changes.flatMap((change) => [
        ...(change.currentPath ? [securitySourceKey('current', change.currentPath)] : []),
        ...(change.basePath ? [securitySourceKey('base', change.basePath)] : []),
      ]))
    : undefined;

  const filtered = new Map<string, OutboundFilterResult>();
  const snippetFor = (unit: SecurityUnit): OutboundFilterResult => {
    const cached = filtered.get(unit.unitId);
    if (cached) return cached;
    const content = (analysis.sources.get(securitySourceKey(unit.revision, unit.path)) ?? '')
      .split('\n')
      .slice(unit.startLine - 1, unit.endLine)
      .join('\n');
    const result = filterSecuritySnippet({
      snippetId: snippetIdForUnitId(unit.unitId),
      path: unit.path,
      revision: unit.revision,
      startLine: unit.startLine,
      endLine: unit.endLine,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
    filtered.set(unit.unitId, result);
    return result;
  };

  const batches: DraftBatch[] = [];
  const sentPaths = new Set<string>();
  const incompleteByReason: Record<string, number> = {};
  const draft = (batchId: string): DraftBatch => {
    const prompt = buildSecurityPrompt({ batchId, units: [], snippets: [] });
    return { batchId, units: [], snippets: [], snippetIds: new Set(), prompt, promptBytes: utf8Bytes(prompt) };
  };
  const totalBytes = () => batches.reduce((total, batch) => total + batch.promptBytes, 0);
  const isFull = () =>
    batches.length >= policy.maxBatches && batches.every((batch) => batch.units.length >= SECURITY_UNITS_PER_BATCH);

  const tryPlace = (unit: SecurityUnit, snippets: SecuritySnippet[]): boolean => {
    if (new Set([...sentPaths, ...snippets.map((snippet) => snippet.path)]).size > policy.llm.maxFiles) return false;
    const unitLineBytes = utf8Bytes(securityUnitLine(unit, snippets.slice(1).map((snippet) => snippet.snippetId))) + 1;
    const candidates = [
      ...batches.filter((batch) => batch.units.length < SECURITY_UNITS_PER_BATCH),
      ...(batches.length < policy.maxBatches ? [draft(`batch:${batches.length + 1}`)] : []),
    ];
    for (const batch of candidates) {
      const isNew = !batches.includes(batch);
      const added = snippets.filter((snippet) => !batch.snippetIds.has(snippet.snippetId));
      const otherBytes = totalBytes() - (isNew ? 0 : batch.promptBytes);
      // Lower bound: existing unit lines can only grow when shared context arrives, so rejecting here is safe.
      const estimate = batch.promptBytes + unitLineBytes
        + added.reduce((total, snippet) => total + utf8Bytes(securitySnippetBlock(snippet)) + 1, 0);
      if (estimate > policy.llm.maxPromptBytes || otherBytes + estimate > policy.maxTotalPromptBytes) continue;

      const units = [...batch.units, unit];
      const batchSnippets = [...batch.snippets, ...added];
      const prompt = buildSecurityPrompt({ batchId: batch.batchId, units, snippets: batchSnippets });
      const promptBytes = utf8Bytes(prompt);
      if (promptBytes > policy.llm.maxPromptBytes || otherBytes + promptBytes > policy.maxTotalPromptBytes) continue;

      Object.assign(batch, { units, snippets: batchSnippets, prompt, promptBytes });
      for (const snippet of added) batch.snippetIds.add(snippet.snippetId);
      if (isNew) batches.push(batch);
      for (const snippet of snippets) sentPaths.add(snippet.path);
      return true;
    }
    return false;
  };
  const fitsAlone = (unit: SecurityUnit, snippet: SecuritySnippet): boolean =>
    draft('batch:1').promptBytes + utf8Bytes(securityUnitLine(unit, [])) + 1 + utf8Bytes(securitySnippetBlock(snippet)) + 1
      <= policy.llm.maxPromptBytes;

  for (const unit of [...primary].sort(compareByPriority)) {
    if (isFull()) {
      increment(incompleteByReason, 'budget-exhausted');
      continue;
    }
    const own = snippetFor(unit);
    if (!own.snippet) {
      increment(incompleteByReason, own.reasons[0] ?? 'filtered');
      continue;
    }
    const limitations = new Set(unit.limitations);
    if (own.snippet.redactedLines?.length) limitations.add('secret-masked');
    const related: SecuritySnippet[] = [];
    for (const relatedId of unit.relatedUnitIds) {
      const relatedUnit = unitsById.get(relatedId);
      if (!relatedUnit) continue;
      if (allowedKeys && !allowedKeys.has(securitySourceKey(relatedUnit.revision, relatedUnit.path))) {
        limitations.add('related-context-not-sent');
        continue;
      }
      const relatedSnippet = snippetFor(relatedUnit).snippet;
      if (relatedSnippet) related.push(relatedSnippet);
      else limitations.add('related-context-filtered');
    }
    const withLimitations = (extra?: string): SecurityUnit =>
      ({ ...unit, limitations: [...new Set([...limitations, ...(extra ? [extra] : [])])].sort() });

    const placed = tryPlace(withLimitations(), [own.snippet, ...related])
      || (related.length > 0 && tryPlace(withLimitations('related-context-omitted'), [own.snippet]));
    if (!placed) increment(incompleteByReason, fitsAlone(unit, own.snippet) ? 'budget-exhausted' : 'prompt-too-large');
  }
  increment(incompleteByReason, 'source-too-large', oversized.length);

  const selected = batches.flatMap((batch) => batch.units);
  if (batches.length === 0 && primary.length > 0
    && ((incompleteByReason['prompt-too-large'] ?? 0) + (incompleteByReason['budget-exhausted'] ?? 0)) > 0) {
    reasons.push('budget-insufficient');
  }
  const limitations = [
    ...(primary.length > 0 ? [RELATION_LIMITATION] : []),
    ...(selected.some((unit) => unit.limitations.includes('related-context-not-sent')) ? [CHANGED_SEND_SCOPE_LIMITATION] : []),
  ];

  return {
    batches: batches.map(({ snippetIds: _snippetIds, ...batch }) => batch),
    coverage: {
      ...emptyCoverage(snapshot.truncated),
      eligibleFiles: new Set([...primary.map((unit) => unit.path), ...oversized.map((source) => source.path)]).size,
      selectedFiles: new Set(selected.map((unit) => unit.path)).size,
      eligibleUnits: primary.length + oversized.length,
      selectedUnits: selected.length,
      excludedByReason,
      incompleteByReason,
    },
    reasons,
    limitations,
  };
}
