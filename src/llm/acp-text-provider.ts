import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOneShotAcpClient } from '../semantic/acp/acp-client.js';
import {
  LLM_ACP_SETUP_TIMEOUT_MS,
  LLM_PROMPT_HARD_TIMEOUT_MS,
  LLM_PROMPT_IDLE_TIMEOUT_MS,
  LLM_PROMPT_OUTPUT_MAX_BYTES,
} from '../semantic/acp/constants.js';
import type { LlmProcess, LlmSpawn } from '../semantic/acp/process-port.js';
import { buildLlmLaunchSpec, getLlmProviderDefinition } from '../semantic/acp/provider-registry.js';
import type { LlmFailureReason, LlmInspection, LlmProviderId } from '../semantic/acp/provider-types.js';
import type { LlmConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';
import { resolveTrustedExecutable, sanitizeExecutableSearchPath } from '../shared/executable-path.js';

import { isSecurityConfinementVerified } from './security-capabilities.js';
import type { LlmTextPort, LlmTextResult } from './text-provider.js';

/** Time kept back from the caller deadline for cancellation, termination, and temporary directory removal. */
export const SECURITY_CLEANUP_RESERVE_MS = 1_000;

/** Lets the shared deadline fire before per-stage ACP timers that were clamped to the same budget. */
const STAGE_TIMEOUT_SLACK_MS = 100;
const SECURITY_TOOL_CALL_ABORT_THRESHOLD = 1;

export type SecurityTextProviderInput = {
  llm: LlmConfig;
  repositoryRoot: string;
  spawn?: LlmSpawn;
  resolveExecutable?: typeof resolveTrustedExecutable;
  verifyConfinement?: (input: { providerId: LlmProviderId; agentInfo: LlmInspection['agentInfo'] }) => boolean;
  cleanupReserveMs?: number;
};

type RunningProcess = { process: LlmProcess; exited: Promise<void> };

function failure(reason: string): LlmTextResult {
  return { ok: false, reason };
}

function reasonCode(reason: LlmFailureReason): string {
  return reason.replaceAll('_', '-');
}

function isWithinOrSame(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function settlesWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([exited.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trackProcesses(spawn: LlmSpawn): { spawn: LlmSpawn; terminate(graceMs: number): Promise<void> } {
  const running = new Set<RunningProcess>();
  return {
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      let markExited: () => void = () => undefined;
      const entry: RunningProcess = { process: child, exited: new Promise((resolve) => { markExited = resolve; }) };
      const settle = () => {
        running.delete(entry);
        markExited();
      };
      child.once('exit', settle);
      child.once('error', settle);
      running.add(entry);
      return child;
    },
    async terminate(graceMs) {
      await Promise.all([...running].map(async (entry) => {
        entry.process.kill('SIGTERM');
        if (await settlesWithin(entry.exited, graceMs)) return;
        entry.process.kill('SIGKILL');
        await settlesWithin(entry.exited, graceMs);
      }));
    },
  };
}

/**
 * One-shot ACP text completion for the security add-on. Each call launches a new provider process from an
 * empty temporary directory outside the analyzed repository, never uses executables or PATH entries under
 * that repository, stops before creating a session unless the provider/version has verified confinement,
 * and finishes cancellation, termination, and cleanup within the caller deadline.
 */
export function createSecurityTextProvider(input: SecurityTextProviderInput): LlmTextPort {
  const reserveMs = input.cleanupReserveMs ?? SECURITY_CLEANUP_RESERVE_MS;
  const resolveExecutable = input.resolveExecutable ?? resolveTrustedExecutable;
  const verifyConfinement = input.verifyConfinement ?? isSecurityConfinementVerified;

  return {
    async complete(request) {
      const { llm } = input;
      if (llm.provider === 'none') return failure('provider-not-configured');
      if (request.signal.aborted) return failure('cancelled');
      const budgetMs = request.deadlineAt - reserveMs - Date.now();
      if (budgetMs <= 0) return failure('deadline-exceeded');

      const providerId = llm.provider;
      let untrustedRoots: string[];
      let command: string | undefined;
      try {
        untrustedRoots = [await realpath(input.repositoryRoot)];
        const searchPath = sanitizeExecutableSearchPath(process.env.PATH, untrustedRoots);
        const requested = llm.executablePath ?? getLlmProviderDefinition(providerId).defaultExecutablePath;
        command = resolveExecutable(requested, searchPath, untrustedRoots);
      } catch (error) {
        if (error instanceof R3DoctorError) return failure('untrusted-executable');
        throw error;
      }
      if (!command) return failure('executable-missing');

      const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-security-')));
      const tracked = trackProcesses(input.spawn ?? (nodeSpawn as LlmSpawn));
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      request.signal.addEventListener('abort', onCallerAbort, { once: true });
      let deadlineFired = false;
      const deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        controller.abort();
      }, budgetMs);

      try {
        if (untrustedRoots.some((root) => isWithinOrSame(root, cwd))) {
          return failure('untrusted-runtime-directory');
        }
        const spec = buildLlmLaunchSpec(providerId, {
          executablePath: command,
          modelIdentifier: llm.model ?? (providerId === 'copilot' ? 'auto' : ''),
          cwd,
          untrustedRepositoryRoots: untrustedRoots,
          inheritedEnv: process.env,
        });
        const stageTimeoutMs = budgetMs + STAGE_TIMEOUT_SLACK_MS;
        const client = createOneShotAcpClient({
          spawn: tracked.spawn,
          setupTimeoutMs: Math.min(LLM_ACP_SETUP_TIMEOUT_MS, stageTimeoutMs),
          promptPolicy: {
            idleTimeoutMs: Math.min(LLM_PROMPT_IDLE_TIMEOUT_MS, stageTimeoutMs),
            hardTimeoutMs: Math.min(LLM_PROMPT_HARD_TIMEOUT_MS, stageTimeoutMs),
            toolCallAbortThreshold: SECURITY_TOOL_CALL_ABORT_THRESHOLD,
          },
        });
        const result = await client.oneShotPrompt({
          spec,
          prompt: request.prompt,
          outputMaxBytes: Math.min(request.outputMaxBytes, LLM_PROMPT_OUTPUT_MAX_BYTES),
          modelIdentifier: llm.model,
          signal: controller.signal,
          verifyInitialize: (inspection) =>
            verifyConfinement({ providerId, agentInfo: inspection.agentInfo }) ? null : 'confinement_unsupported',
        });
        if (!result.ok) {
          return failure(deadlineFired ? 'deadline-exceeded' : reasonCode(result.reason));
        }
        return {
          ok: true,
          text: result.value.text,
          agentVersion: result.value.inspection.agentInfo?.version ?? null,
          resolvedModel: result.value.resolvedModel,
          inputTokens: result.value.usage?.inputTokens ?? null,
          outputTokens: result.value.usage?.outputTokens ?? null,
        };
      } catch (error) {
        if (error instanceof R3DoctorError) return failure('untrusted-executable');
        throw error;
      } finally {
        clearTimeout(deadlineTimer);
        request.signal.removeEventListener('abort', onCallerAbort);
        await tracked.terminate(Math.max(1, Math.floor(reserveMs / 2)));
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
