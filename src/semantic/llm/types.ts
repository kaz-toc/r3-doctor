import type { LlmFailureReason, LlmProviderId } from '../acp/provider-types.js';

export type LlmProviderInspectRow = {
  providerId: LlmProviderId;
  status: 'available' | 'unavailable';
  reason?: LlmFailureReason;
  agentInfo?: { name: string; version?: string };
  authMethods: readonly string[];
  installHint: string;
};

export type LlmInspectExitCode = 0 | 1 | 2;
