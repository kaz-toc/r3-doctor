import type { CapabilityResult, Evidence, RiskAxisId, SignalId } from '../schema/report.v1.js';
import { MECHANISM_FOR_SIGNAL, SIGNAL_AXIS } from '../schema/report.v1.js';
import { classifyPathRole } from '../evidence/path-role.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';

export function isSignalSupported(signalId: SignalId, capabilities: CapabilityResult[]): boolean {
  return capabilities.some((capability) => capability.supportedSignals.includes(signalId));
}

export function capabilityApprovedEvidence(
  evidence: Evidence[],
  capabilities: CapabilityResult[],
): Evidence[] {
  return evidence.filter((item) => isSignalSupported(item.signalId, capabilities));
}

export function axisHasSupportedSignals(axisId: RiskAxisId, capabilities: CapabilityResult[]): boolean {
  const axisSignals = (Object.entries(SIGNAL_AXIS) as Array<[SignalId, RiskAxisId]>)
    .filter(([, mappedAxis]) => mappedAxis === axisId)
    .map(([signal]) => signal);
  return capabilities.some((capability) => axisSignals.some((signal) => capability.supportedSignals.includes(signal)));
}

export function evaluableMechanismIdsForAxis(axisId: RiskAxisId, capabilities: CapabilityResult[]): string[] {
  if (axisId === 'semantic-ambiguity') {
    return ['semantic-ambiguity'];
  }

  const supportedSignals = new Set(capabilities.flatMap((capability) => capability.supportedSignals));
  const mechanismIds = new Set<string>();
  for (const [signal, mappedAxis] of Object.entries(SIGNAL_AXIS) as Array<[SignalId, RiskAxisId]>) {
    if (mappedAxis !== axisId || !supportedSignals.has(signal)) {
      continue;
    }
    mechanismIds.add(MECHANISM_FOR_SIGNAL[signal as Exclude<SignalId, 'semantic-ambiguity'>]);
  }
  return [...mechanismIds].sort();
}

export function countProductPaths(snapshot: RepositorySnapshot): number {
  const skipRoots = snapshot.config.diagnosticSkipRoots ?? [];
  return snapshot.files.filter((file) => classifyPathRole(file.relativePath, skipRoots) === 'product').length;
}
