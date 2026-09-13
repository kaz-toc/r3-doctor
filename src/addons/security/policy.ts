import type { LlmConfig } from '../../shared/config.js';
import { R3DoctorError } from '../../shared/errors.js';

import type { OperatorSecuritySettings, RepositorySecurityDeclaration } from './config.js';
import type { SecurityCliOptions, SecurityDecision, SecurityMode, SecurityScope } from './types.js';

export const SECURITY_POLICY_DEFAULTS = {
  maxBatches: 4,
  maxTotalPromptBytes: 240_000,
  timeoutMs: 180_000,
} as const;

export type SecurityPolicyInput = {
  mode: SecurityMode;
  /** Realpath of the analyzed repository root, resolved by the caller. */
  canonicalRoot: string;
  cli: SecurityCliOptions;
  repository: RepositorySecurityDeclaration | undefined;
  /** Settings from a trusted profile whose repository roots were already canonicalized. */
  operator: OperatorSecuritySettings | undefined;
  llm: LlmConfig;
};

/**
 * Resolves the feature request as CLI > root-matched operator settings > repository declaration > false.
 * Consent requires an explicit CLI request or a root-matched operator entry; a repository declaration never grants it.
 * Provider availability is checked later by the runner, so this function never starts or selects a provider.
 */
export function resolveSecurityPolicy(input: SecurityPolicyInput): SecurityDecision {
  const { cli, mode } = input;
  if (cli.securityRequired && cli.security === false) {
    throw new R3DoctorError('--security-required cannot be combined with --no-security');
  }
  if (mode === 'diff' && cli.securityScope === 'repository') {
    throw new R3DoctorError('--security-scope repository is not available for diff; diff checks changed code only');
  }

  const matched = input.operator?.repositories.includes(input.canonicalRoot) ? input.operator : undefined;
  const cliEnabled = cli.securityRequired ? true : cli.security;
  const requested = cliEnabled ?? matched?.enabled ?? input.repository?.enabled ?? false;
  if (!requested) {
    return { kind: 'disabled', required: false };
  }

  const required = cli.securityRequired === true;
  if (cliEnabled !== true && matched?.enabled !== true) {
    return { kind: 'blocked', required, reason: 'operator-consent-required' };
  }

  return {
    kind: 'enabled',
    required,
    policy: {
      mode,
      scope: resolveScope(input, matched),
      required,
      llm: input.llm,
      maxBatches: matched?.maxBatches ?? SECURITY_POLICY_DEFAULTS.maxBatches,
      maxTotalPromptBytes: matched?.maxTotalPromptBytes ?? SECURITY_POLICY_DEFAULTS.maxTotalPromptBytes,
      timeoutMs: matched?.timeoutMs ?? SECURITY_POLICY_DEFAULTS.timeoutMs,
    },
  };
}

function resolveScope(input: SecurityPolicyInput, matched: OperatorSecuritySettings | undefined): SecurityScope {
  if (input.mode === 'diff') {
    return 'changed';
  }
  return input.cli.securityScope ?? matched?.scope ?? input.repository?.scope ?? 'repository';
}
