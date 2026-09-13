import type { AgentCapabilities, AuthMethod } from '@agentclientprotocol/sdk';
import { z } from 'zod';

export const llmProviderIdSchema = z.enum(['copilot', 'cursor', 'codex', 'claude']);
export type LlmProviderId = z.infer<typeof llmProviderIdSchema>;

export type LlmLaunchInput = {
  executablePath: string;
  modelIdentifier: string;
  /** Working directory of the provider process. */
  cwd: string;
  /** Roots whose executables and PATH entries are never used, checked independently from `cwd`. */
  untrustedRepositoryRoots: readonly string[];
  inheritedEnv: NodeJS.ProcessEnv;
};

export type LlmLaunchSpec = {
  providerId: LlmProviderId;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type LlmFailureReason =
  | 'executable_missing'
  | 'protocol_incompatible'
  | 'authentication_required'
  | 'authentication_failed'
  | 'safe_mode_unavailable'
  | 'confinement_unsupported'
  | 'model_unavailable'
  | 'process_exited'
  | 'timeout'
  | 'tool_use_limit'
  | 'cancelled'
  | 'invalid_response';

export type LlmInspection = {
  providerId: LlmProviderId;
  agentInfo?: { name: string; version?: string };
  authMethods: readonly AuthMethod[];
  capabilities: AgentCapabilities;
};

export type LlmResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: LlmFailureReason };
