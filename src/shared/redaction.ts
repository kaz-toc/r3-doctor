import { createHash } from 'node:crypto';

import { diagnosisReportSchema, diffReportSchema } from '../schema/report.v1.js';
import type { DiffReport, DiagnosisReport, EvidenceChange, BlastRadiusEntry } from '../schema/report.v1.js';
import { R3DoctorError } from './errors.js';

const REDACTION_TOKEN_PATTERN = /\[REDACTED(?:-RAW)?:[a-f0-9]{64}\]/g;
export const REDACTED_REPOSITORY_PATH = '[REPOSITORY]';

function normalizeRedactionPaths(redactPaths: string[]): string[] {
  return [...new Set(redactPaths)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export function redactionPolicyFingerprint(redactPaths: string[]): string {
  const normalized = normalizeRedactionPaths(redactPaths);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function escapeRawRedactionTokens(value: string): string {
  return value.replace(REDACTION_TOKEN_PATTERN, (token) => {
    const pseudonym = createHash('sha256').update(`r3-doctor-redaction-raw-v1\0${token}`).digest('hex');
    return `[REDACTED-RAW:${pseudonym}]`;
  });
}

function redactString(value: string, redactPaths: string[], preserveTokens = false): string {
  if (redactPaths.length === 0) {
    return value;
  }
  let result = preserveTokens ? value : escapeRawRedactionTokens(value);
  for (const pattern of redactPaths) {
    const pseudonym = createHash('sha256').update(`r3-doctor-redaction-v1\0${pattern}`).digest('hex');
    const replacement = `[REDACTED:${pseudonym}]`;
    let cursor = 0;
    let protectedResult = '';
    for (const match of result.matchAll(REDACTION_TOKEN_PATTERN)) {
      const matchIndex = match.index ?? 0;
      protectedResult += result.slice(cursor, matchIndex).split(pattern).join(replacement);
      protectedResult += match[0];
      cursor = matchIndex + match[0].length;
    }
    protectedResult += result.slice(cursor).split(pattern).join(replacement);
    result = protectedResult;
  }
  return result;
}

function redactEntityId(value: string, namespace: string, redactPaths: string[]): string {
  const prefix = `${namespace}:`;
  if (!value.startsWith(prefix)) {
    return redactString(value, redactPaths);
  }
  return `${prefix}${redactString(value.slice(prefix.length), redactPaths)}`;
}

function redactOptionalString(value: string | undefined, redactPaths: string[]): string | undefined {
  return value ? redactString(value, redactPaths) : value;
}

function redactMetrics(
  metrics: Record<string, string | number | boolean> | undefined,
  redactPaths: string[],
): Record<string, string | number | boolean> | undefined {
  if (!metrics || redactPaths.length === 0) {
    return metrics;
  }
  const redacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metrics)) {
    redacted[key] = typeof value === 'string' ? redactString(value, redactPaths) : value;
  }
  return redacted;
}

function redactEvidenceChange(change: EvidenceChange, redactPaths: string[]): EvidenceChange {
  return {
    ...change,
    evidenceId: change.evidenceId.startsWith('evidence:')
      ? `evidence:${redactString(change.evidenceId.slice('evidence:'.length), redactPaths, true)}`
      : redactString(change.evidenceId, redactPaths, true),
    path: change.path ? redactString(change.path, redactPaths, true) : change.path,
    message: redactString(change.message, redactPaths, true),
  };
}

function redactBlastRadiusEntry(entry: BlastRadiusEntry, redactPaths: string[]): BlastRadiusEntry {
  return {
    changedFile: redactString(entry.changedFile, redactPaths),
    directDependents: entry.directDependents.map((p) => redactString(p, redactPaths)),
    directDependencies: entry.directDependencies.map((p) => redactString(p, redactPaths)),
    transitiveDependents: entry.transitiveDependents.map((p) => redactString(p, redactPaths)),
    transitiveDependencies: entry.transitiveDependencies.map((p) => redactString(p, redactPaths)),
    paths: entry.paths.map((edge) => ({
      from: redactString(edge.from, redactPaths),
      to: redactString(edge.to, redactPaths),
    })),
  };
}

export function redactReport(report: DiagnosisReport, redactPaths: string[]): DiagnosisReport {
  const normalized = normalizeRedactionPaths(redactPaths);
  const fingerprint = redactionPolicyFingerprint(normalized);
  if (report.metadata.redactionPolicyFingerprint) {
    if (report.metadata.redactionPolicyFingerprint !== fingerprint) {
      throw new R3DoctorError('cannot apply a different redaction policy to an already-redacted report');
    }
    return diagnosisReportSchema.parse({
      ...report,
      metadata: {
        ...report.metadata,
        repositoryPath: REDACTED_REPOSITORY_PATH,
      },
    });
  }
  const redacted = {
    ...report,
    metadata: {
      ...report.metadata,
      repositoryPath: REDACTED_REPOSITORY_PATH,
      unevaluatedAreas: report.metadata.unevaluatedAreas.map((area) => redactString(area, normalized)),
      redactionPolicyFingerprint: fingerprint,
    },
    clusters: report.clusters.map((cluster) => ({
      ...cluster,
      clusterId: redactEntityId(cluster.clusterId, 'cluster', normalized),
      paths: cluster.paths.map((p) => redactString(p, normalized)),
      triggerChanges: cluster.triggerChanges.map((t) => redactString(t, normalized)),
      evidenceIds: cluster.evidenceIds.map((id) => redactEntityId(id, 'evidence', normalized)),
    })),
    evidence: report.evidence.map((item) => ({
      ...item,
      evidenceId: redactEntityId(item.evidenceId, 'evidence', normalized),
      path: redactOptionalString(item.path, normalized),
      message: redactString(item.message, normalized),
      metrics: redactMetrics(item.metrics, normalized),
    })),
    semanticFindings: report.semanticFindings.map((finding) => ({
      ...finding,
      findingId: redactEntityId(finding.findingId, 'finding', normalized),
      path: redactOptionalString(finding.path, normalized),
      summary: redactString(finding.summary, normalized),
      relatedEvidenceIds: finding.relatedEvidenceIds.map((id) => redactEntityId(id, 'evidence', normalized)),
    })),
    interventions: report.interventions.map((item) => ({
      ...item,
      interventionId: redactEntityId(item.interventionId, 'intervention', normalized),
      targetPaths: item.targetPaths.map((p) => redactString(p, normalized)),
      description: redactString(item.description, normalized),
      verification: redactString(item.verification, normalized),
      linkedClusterIds: item.linkedClusterIds.map((id) => redactEntityId(id, 'cluster', normalized)),
    })),
  };
  return diagnosisReportSchema.parse(redacted);
}

export function redactDiffReport(diff: DiffReport, redactPaths: string[]): DiffReport {
  const normalized = normalizeRedactionPaths(redactPaths);
  const fingerprint = redactionPolicyFingerprint(normalized);
  if (diff.redactionPolicyFingerprint) {
    if (diff.redactionPolicyFingerprint !== fingerprint) {
      throw new R3DoctorError('cannot apply a different redaction policy to an already-redacted diff report');
    }
    return diffReportSchema.parse(diff);
  }

  const redacted = {
    ...diff,
    redactionPolicyFingerprint: fingerprint,
    current: redactReport(diff.current, normalized),
    base: diff.base ? redactReport(diff.base, normalized) : undefined,
    comparison: {
      ...diff.comparison,
      reason: redactOptionalString(diff.comparison.reason, normalized),
      changedFiles: diff.comparison.changedFiles.map((file) => redactString(file, normalized)),
      blastRadius: diff.comparison.blastRadius.map((entry) => redactBlastRadiusEntry(entry, normalized)),
      newSignals: diff.comparison.newSignals.map((change) => redactEvidenceChange(change, normalized)),
      worsenedSignals: diff.comparison.worsenedSignals.map((change) => redactEvidenceChange(change, normalized)),
      improvedSignals: diff.comparison.improvedSignals.map((change) => redactEvidenceChange(change, normalized)),
    },
  };
  return diffReportSchema.parse(redacted);
}

export function redactStringList(values: string[], redactPaths: string[]): string[] {
  const normalized = normalizeRedactionPaths(redactPaths);
  return values.map((value) => redactString(value, normalized));
}
