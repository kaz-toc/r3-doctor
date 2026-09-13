import { z } from 'zod';

import type {
  SecurityConfidence,
  SecurityEvidenceRef,
  SecuritySeverity,
} from '../../schema/security-assessment.v1.js';

export const SECURITY_SEVERITY_RUBRIC_VERSION = '1.0.0';

export const securityImpactClassSchema = z.enum([
  'arbitrary-execution',
  'cross-tenant-access',
  'sensitive-data-access',
  'limited-data-access',
  'defense-in-depth',
]);

export const securityAttackPrerequisiteSchema = z.enum(['none', 'authenticated', 'privileged', 'unknown']);

export type SecurityImpactClass = z.infer<typeof securityImpactClassSchema>;
export type SecurityAttackPrerequisite = z.infer<typeof securityAttackPrerequisiteSchema>;

const SEVERITY_ORDER: readonly SecuritySeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** Unit limitations meaning a guard, caller, or middleware could not be resolved or was not sent. */
const UNRESOLVED_CONTEXT_LIMITATIONS = new Set([
  'dynamic-import',
  'dynamic-require',
  'computed-call',
  'external-middleware',
  'unresolved-import',
  'related-context-not-sent',
  'related-context-omitted',
  'related-context-filtered',
  'related-context-truncated',
]);

export function higherSeverity(left: SecuritySeverity, right: SecuritySeverity): SecuritySeverity {
  return SEVERITY_ORDER.indexOf(left) >= SEVERITY_ORDER.indexOf(right) ? left : right;
}

function lowerSeverity(left: SecuritySeverity, right: SecuritySeverity): SecuritySeverity {
  return SEVERITY_ORDER.indexOf(left) <= SEVERITY_ORDER.indexOf(right) ? left : right;
}

/**
 * Fixed rubric from the model's impact and prerequisite classification. The model never supplies the
 * public severity: arbitrary execution or cross-tenant access without prerequisites is critical, other
 * cases follow the impact class, unknown prerequisites cap at medium, and context-only evidence is info.
 */
export function classifySeverity(input: {
  impact: SecurityImpactClass;
  prerequisites: SecurityAttackPrerequisite;
  evidenceRoles?: readonly SecurityEvidenceRef['role'][];
}): SecuritySeverity {
  if (input.evidenceRoles && input.evidenceRoles.length > 0 && input.evidenceRoles.every((role) => role === 'context')) {
    return 'info';
  }
  const byImpact: Record<SecurityImpactClass, SecuritySeverity> = {
    'arbitrary-execution': input.prerequisites === 'none' ? 'critical' : 'high',
    'cross-tenant-access': input.prerequisites === 'none' ? 'critical' : 'high',
    'sensitive-data-access': 'high',
    'limited-data-access': 'medium',
    'defense-in-depth': 'low',
  };
  const severity = byImpact[input.impact];
  return input.prerequisites === 'unknown' ? lowerSeverity(severity, 'medium') : severity;
}

/** A valid evidence reference alone never raises confidence; missing or contradictory context caps it at low. */
export function capSecurityConfidence(input: {
  proposed: SecurityConfidence;
  prerequisites: SecurityAttackPrerequisite;
  unitStatus: 'evaluated' | 'insufficient-context';
  unitLimitations: readonly string[];
  conflicting: boolean;
}): SecurityConfidence {
  const limited = input.prerequisites === 'unknown'
    || input.unitStatus === 'insufficient-context'
    || input.conflicting
    || input.unitLimitations.some((limitation) => UNRESOLVED_CONTEXT_LIMITATIONS.has(limitation));
  return limited ? 'low' : input.proposed;
}
