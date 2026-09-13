import type { LlmInspection, LlmProviderId } from '../semantic/acp/provider-types.js';

export type SecurityConfinementSupport = Readonly<{
  providerId: LlmProviderId;
  agentName: string;
  agentVersions: readonly string[];
  /** Where suppression of built-in tools, global MCP servers, instruction loading, and logging was confirmed. */
  evidence: string;
}>;

/**
 * Provider/version combinations confirmed to run security prompts without built-in tools, global MCP
 * servers, automatic instruction loading, or retained logs. Working semantic analysis is not evidence.
 * Intentionally empty until an authenticated canary confirms a combination (ADR 0006).
 */
export const SECURITY_CONFINEMENT_SUPPORT: readonly SecurityConfinementSupport[] = [];

export function isSecurityConfinementVerified(
  input: { providerId: LlmProviderId; agentInfo: LlmInspection['agentInfo'] },
  support: readonly SecurityConfinementSupport[] = SECURITY_CONFINEMENT_SUPPORT,
): boolean {
  const agent = input.agentInfo;
  if (!agent?.version) return false;
  return support.some((entry) =>
    entry.providerId === input.providerId &&
    entry.agentName === agent.name &&
    entry.agentVersions.includes(agent.version ?? ''),
  );
}
