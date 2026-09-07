import { z } from 'zod';
import path from 'node:path';

import type { SemanticFinding } from '../schema/report.v1.js';
import { findingIdSchema, riskAxisIdSchema, semanticFindingSchema, evidenceIdSchema } from '../schema/report.v1.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { Evidence } from '../schema/report.v1.js';
import { DefaultSemanticProviderFactory } from './provider-factory.js';
import type { SemanticProvider, SemanticProviderFactory, SemanticProviderResolution } from './types.js';

export type { SemanticProvider, SemanticProviderFactory, SemanticProviderResolution } from './types.js';
export { DefaultSemanticProviderFactory } from './provider-factory.js';
export { normalizeProviderId } from './provider-ids.js';

const providerOutputSchema = z.array(
  z
    .object({
      findingId: findingIdSchema.optional(),
      axisId: riskAxisIdSchema,
      path: z.string().optional(),
      summary: z.string(),
      relatedEvidenceIds: z.array(evidenceIdSchema).default([]),
      confidence: z.number().min(0).max(1),
    })
    .strict(),
);

export class NullSemanticProvider implements SemanticProvider {
  readonly name = 'none';
  readonly implementationVersion = '1.0.0';

  async analyze(): Promise<unknown> {
    return [];
  }
}

export function selectLlmCandidateFiles(snapshot: RepositorySnapshot, evidence: Evidence[]): RepositorySnapshot['files'] {
  const maxFiles = snapshot.config.llm.maxFiles;
  const sendScope = snapshot.config.llm.sendScope;

  let candidates = [...snapshot.files];
  if (sendScope === 'changed') {
    const evidencePaths = new Set(evidence.map((item) => item.path).filter(Boolean) as string[]);
    candidates = candidates.filter((file) => evidencePaths.has(file.relativePath));
  } else if (sendScope === 'cluster-context') {
    const evidencePaths = new Set(evidence.map((item) => item.path).filter(Boolean) as string[]);
    candidates = candidates.filter(
      (file) =>
        evidencePaths.has(file.relativePath) ||
        evidence.some((item) => item.path && file.relativePath.startsWith(`${item.path.split('/')[0]}/`)),
    );
  }

  return candidates.sort((a, b) => b.nonBlankLines - a.nonBlankLines).slice(0, maxFiles);
}

export function validateSemanticFindings(
  raw: unknown,
  snapshot: RepositorySnapshot,
  evidence: Evidence[],
): SemanticFinding[] {
  const parsed = providerOutputSchema.parse(raw).filter((item) => item.axisId === 'semantic-ambiguity');
  const evidenceIds = new Set(evidence.map((item) => item.evidenceId));
  const snapshotPaths = new Set(snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')));

  return parsed.map((item, index) => {
    let normalizedPath: string | undefined;
    if (item.path) {
      const portablePath = item.path.replaceAll('\\', '/');
      const pathSegments = portablePath.split('/');
      if (path.posix.isAbsolute(portablePath) || /^[A-Za-z]:\//u.test(portablePath)) {
        throw new Error(`semantic finding path must be repository-relative: ${item.path}`);
      }
      if (pathSegments.includes('..')) {
        throw new Error(`semantic finding path escapes repository: ${item.path}`);
      }
      normalizedPath = path.posix.normalize(portablePath);
      if (normalizedPath === '.' || !snapshotPaths.has(normalizedPath)) {
        throw new Error(`semantic finding path is not in the repository snapshot: ${item.path}`);
      }
    }

    for (const evidenceId of item.relatedEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`dangling evidence reference in semantic finding: ${evidenceId}`);
      }
    }

    const finding: SemanticFinding = {
      findingId: item.findingId ?? `finding:semantic:${index + 1}`,
      axisId: item.axisId,
      path: normalizedPath,
      summary: item.summary,
      relatedEvidenceIds: item.relatedEvidenceIds,
      confidence: item.confidence,
    };

    return semanticFindingSchema.parse(finding);
  });
}

export async function resolveSemanticProvider(
  snapshot: RepositorySnapshot,
  factory: SemanticProviderFactory = new DefaultSemanticProviderFactory(),
): Promise<SemanticProviderResolution> {
  try {
    return factory.create(snapshot.config.llm);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', reason: `invalid LLM config: ${reason}` };
  }
}

export async function runSemanticAnalysis(
  snapshot: RepositorySnapshot,
  evidence: Evidence[],
  factory: SemanticProviderFactory = new DefaultSemanticProviderFactory(),
): Promise<{ findings: SemanticFinding[]; resolution: SemanticProviderResolution }> {
  const resolution = await resolveSemanticProvider(snapshot, factory);
  if (resolution.status !== 'available') {
    return { findings: [], resolution };
  }

  try {
    const scopedSnapshot = {
      ...snapshot,
      files: selectLlmCandidateFiles(snapshot, evidence),
    };
    const raw = await resolution.provider.analyze(scopedSnapshot, evidence);
    const findings = validateSemanticFindings(raw, snapshot, evidence);
    return { findings, resolution };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      findings: [],
      resolution: { status: 'unavailable', reason: `semantic provider failed: ${reason}` },
    };
  }
}
