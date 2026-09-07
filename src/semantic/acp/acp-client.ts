import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import type {
  ClientCapabilities,
  InitializeResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from '@agentclientprotocol/sdk';

import {
  LLM_ACP_SETUP_TIMEOUT_MS,
  LLM_PROMPT_HARD_TIMEOUT_MS,
  LLM_PROMPT_IDLE_TIMEOUT_MS,
  LLM_TOOL_CALL_ABORT_THRESHOLD,
} from './constants.js';
import { getLlmProviderDefinition } from './provider-registry.js';
import { spawnLlmProcess, type LlmProcess, type LlmSpawn } from './process-port.js';
import type {
  LlmFailureReason,
  LlmInspection,
  LlmLaunchSpec,
  LlmResult,
} from './provider-types.js';

export const LLM_ACP_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  session: { configOptions: { boolean: {} } },
};

export type LlmPromptPolicy = Readonly<{
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  toolCallAbortThreshold: number;
}>;

export const DEFAULT_LLM_PROMPT_POLICY: LlmPromptPolicy = {
  idleTimeoutMs: LLM_PROMPT_IDLE_TIMEOUT_MS,
  hardTimeoutMs: LLM_PROMPT_HARD_TIMEOUT_MS,
  toolCallAbortThreshold: LLM_TOOL_CALL_ABORT_THRESHOLD,
};

export type OneShotAcpClient = {
  inspect(input: { spec: LlmLaunchSpec; signal?: AbortSignal }): Promise<LlmResult<LlmInspection>>;
  oneShotPrompt(input: {
    spec: LlmLaunchSpec;
    prompt: string;
    outputMaxBytes: number;
    modelIdentifier?: string;
    signal?: AbortSignal;
  }): Promise<LlmResult<{ text: string }>>;
};

type AcpConnection = ReturnType<ReturnType<typeof acp.client>['connect']>;

type ConnectionResource = {
  connection: AcpConnection;
  process: LlmProcess;
  error: Promise<never>;
  spec: LlmLaunchSpec;
  inspection: LlmInspection;
  cancelPromises: Map<string, Promise<void>>;
  stop(cause?: Error): void;
};

type LlmAcpSession = {
  sessionId: string;
  providerId: LlmLaunchSpec['providerId'];
  activeSession: acp.ActiveSession;
};

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  const flat: SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ('options' in entry && Array.isArray(entry.options)) {
      flat.push(...entry.options);
    } else if ('value' in entry) {
      flat.push(entry);
    }
  }
  return flat;
}

function findModeOption(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): SessionConfigOption | undefined {
  return configOptions?.find((option) => option.category === 'mode' || option.id === 'mode');
}

function findModelOption(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): SessionConfigOption | undefined {
  return configOptions?.find((option) => option.category === 'model' || option.id === 'model');
}

function selectOptionValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  return flattenSelectOptions(option.options).map((entry) => entry.value);
}

function mapFailure(error: unknown): LlmFailureReason {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return 'executable_missing';
  }
  if (error instanceof acp.RequestError) {
    if (error.code === -32000) return 'authentication_required';
    if (error.code === -32800) return 'cancelled';
    const message = error.message.toLowerCase();
    if (message.includes('auth')) return 'authentication_failed';
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('protocol_incompatible')) return 'protocol_incompatible';
    if (message.includes('authentication_required')) return 'authentication_required';
    if (message.includes('authentication_failed')) return 'authentication_failed';
    if (message.includes('safe_mode_unavailable')) return 'safe_mode_unavailable';
    if (message.includes('model_unavailable')) return 'model_unavailable';
    if (message.includes('process_exited')) return 'process_exited';
    if (message.includes('tool_use_limit')) return 'tool_use_limit';
    if (message.includes('output_limit')) return 'invalid_response';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('cancelled')) return 'cancelled';
    if (message.includes('auth')) return 'authentication_failed';
  }
  return 'protocol_incompatible';
}

function ok<T>(value: T): LlmResult<T> {
  return { ok: true, value };
}

function fail<T>(reason: LlmFailureReason): LlmResult<T> {
  return { ok: false, reason };
}

function buildClientApp() {
  return acp
    .client({ name: 'r3-doctor' })
    .onRequest(
      acp.methods.client.session.requestPermission,
      async () => ({ outcome: { outcome: 'cancelled' } }),
    )
    .onRequest('cursor/ask_question', (params: unknown) => params, async () => ({
      outcome: { outcome: 'cancelled' },
    }))
    .onRequest('cursor/create_plan', (params: unknown) => params, async () => ({
      outcome: { outcome: 'rejected', reason: 'r3-doctor semantic analysis is non-interactive' },
    }));
}

function connect(options: { spec: LlmLaunchSpec; spawn?: LlmSpawn }): ConnectionResource {
  const process = spawnLlmProcess(options.spec, options.spawn);
  let rejectError: (error: Error) => void = () => undefined;
  const error = new Promise<never>((_resolve, reject) => {
    rejectError = reject;
  });
  error.catch(() => undefined);

  const resourceRef: { current?: ConnectionResource } = {};
  const stopFromProcess = (cause: Error) => {
    if (resourceRef.current) resourceRef.current.stop(cause);
    else {
      process.kill();
      rejectError(cause);
    }
  };

  let spawnError: (Error & { code?: string }) | undefined;
  process.once('error', (error) => {
    spawnError = error;
    stopFromProcess(error);
  });
  process.once('exit', () => stopFromProcess(new Error('llm_acp_process_exited')));
  if (spawnError) throw spawnError;

  const clientApp = buildClientApp();
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = clientApp.connect(stream);

  let stopped = false;
  const resource: ConnectionResource = {
    connection,
    process,
    error,
    spec: options.spec,
    inspection: {
      providerId: options.spec.providerId,
      authMethods: [],
      capabilities: {},
    },
    cancelPromises: new Map(),
    stop(cause?: Error) {
      if (stopped) return;
      stopped = true;
      connection.close();
      process.kill();
      if (cause) rejectError(cause);
    },
  };
  resourceRef.current = resource;
  return resource;
}

async function race<T>(operation: Promise<T>, resource: ConnectionResource): Promise<T> {
  return Promise.race([operation, resource.error]);
}

async function raceWithTimeout<T>(
  operation: Promise<T>,
  resource: ConnectionResource,
  timeoutMs: number,
  phase: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`llm_acp_timeout_${phase}`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, resource.error, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendSessionCancel(resource: ConnectionResource, sessionId: string): Promise<void> {
  let cancelPromise = resource.cancelPromises.get(sessionId);
  if (!cancelPromise) {
    cancelPromise = (async () => {
      try {
        await resource.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
      } catch {
        // Best effort before cleanup.
      }
    })();
    resource.cancelPromises.set(sessionId, cancelPromise);
  }
  await cancelPromise;
}

async function initialize(
  resource: ConnectionResource,
  signal?: AbortSignal,
): Promise<LlmInspection> {
  const initialized: InitializeResponse = await race(
    resource.connection.agent.request(
      acp.methods.agent.initialize,
      { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: LLM_ACP_CLIENT_CAPABILITIES },
      signal ? { cancellationSignal: signal } : undefined,
    ),
    resource,
  );
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error('llm_acp_protocol_incompatible');
  }
  const inspection: LlmInspection = {
    providerId: resource.spec.providerId,
    agentInfo: initialized.agentInfo
      ? { name: initialized.agentInfo.name, version: initialized.agentInfo.version }
      : undefined,
    authMethods: initialized.authMethods ?? [],
    capabilities: initialized.agentCapabilities ?? {},
  };
  resource.inspection = inspection;
  return inspection;
}

async function createSession(
  resource: ConnectionResource,
  spec: LlmLaunchSpec,
  signal?: AbortSignal,
): Promise<LlmAcpSession> {
  const activeSession = await race(
    resource.connection.agent
      .buildSession({ cwd: spec.cwd, mcpServers: [] })
      .start(signal ? { cancellationSignal: signal } : undefined),
    resource,
  );
  return {
    sessionId: activeSession.sessionId,
    providerId: spec.providerId,
    activeSession,
  };
}

async function configureSession(
  resource: ConnectionResource,
  session: LlmAcpSession,
  modelIdentifier: string | undefined,
  signal?: AbortSignal,
): Promise<LlmResult<void>> {
  try {
    const provider = getLlmProviderDefinition(session.providerId);
    const configOptions = session.activeSession.newSessionResponse.configOptions ?? [];
    const modeOption = findModeOption(configOptions);
    const modelOption = findModelOption(configOptions);
    const requestOptions = signal ? { cancellationSignal: signal } : undefined;

    if (modeOption && provider.preferredModeValues.length > 0) {
      const preferred = provider.preferredModeValues.find((value) =>
        selectOptionValues(modeOption).includes(value),
      );
      if (!preferred) return fail('safe_mode_unavailable');
      if (modeOption.type === 'select' && modeOption.currentValue !== preferred) {
        await race(
          resource.connection.agent.request(
            acp.methods.agent.session.setConfigOption,
            { sessionId: session.sessionId, configId: modeOption.id, value: preferred },
            requestOptions,
          ),
          resource,
        );
      }
    } else if (provider.preferredModeValues.length > 0) {
      const modes = session.activeSession.modes;
      const preferred = provider.preferredModeValues.find((value) =>
        modes?.availableModes.some((mode) => mode.id === value),
      );
      if (!preferred) return fail('safe_mode_unavailable');
      if (modes?.currentModeId !== preferred) {
        await race(
          resource.connection.agent.request(
            acp.methods.agent.session.setMode,
            { sessionId: session.sessionId, modeId: preferred },
            requestOptions,
          ),
          resource,
        );
      }
    }

    if (session.providerId !== 'copilot' && modelIdentifier) {
      if (!modelOption || modelOption.type !== 'select') {
        return fail('model_unavailable');
      }
      const advertised = selectOptionValues(modelOption);
      if (!advertised.includes(modelIdentifier)) return fail('model_unavailable');
      if (modelOption.currentValue !== modelIdentifier) {
        await race(
          resource.connection.agent.request(
            acp.methods.agent.session.setConfigOption,
            { sessionId: session.sessionId, configId: modelOption.id, value: modelIdentifier },
            requestOptions,
          ),
          resource,
        );
      }
    }

    return ok(undefined);
  } catch (error) {
    return fail(mapFailure(error));
  }
}

async function promptSession(
  resource: ConnectionResource,
  session: LlmAcpSession,
  prompt: string,
  outputMaxBytes: number,
  promptPolicy: LlmPromptPolicy,
  signal?: AbortSignal,
): Promise<LlmResult<{ text: string }>> {
  if (!Number.isSafeInteger(outputMaxBytes) || outputMaxBytes < 0) {
    return fail('invalid_response');
  }

  const sendCancel = () => sendSessionCancel(resource, session.sessionId);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle: (error: Error) => void = () => undefined;
  let rejectHard: (error: Error) => void = () => undefined;
  const idleDeadline = new Promise<never>((_resolve, reject) => {
    rejectIdle = reject;
  });
  const hardDeadline = new Promise<never>((_resolve, reject) => {
    rejectHard = reject;
  });
  const resetIdleDeadline = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => rejectIdle(new Error('llm_acp_timeout_idle')),
      promptPolicy.idleTimeoutMs,
    );
  };
  const distinctToolCallIds = new Set<string>();
  const promptController = new AbortController();

  try {
    if (signal?.aborted) {
      await sendCancel();
      return fail('cancelled');
    }

    const chunks: string[] = [];
    const textEncoder = new TextEncoder();
    let retainedOutputBytes = 0;
    const onAbort = () => {
      void sendCancel();
      promptController.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    resetIdleDeadline();
    hardTimer = setTimeout(
      () => rejectHard(new Error('llm_acp_timeout_hard')),
      promptPolicy.hardTimeoutMs,
    );

    try {
      const promptResult = session.activeSession.prompt(prompt, {
        cancellationSignal: promptController.signal,
      });
      for (;;) {
        const next = await Promise.race([
          session.activeSession.nextUpdate(),
          resource.error,
          idleDeadline,
          hardDeadline,
        ]);
        if (next.kind === 'session_update') {
          const update = next.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            const text = update.content.text;
            if (text.length === 0) continue;
            const chunkBytes = textEncoder.encode(text).byteLength;
            if (retainedOutputBytes + chunkBytes > outputMaxBytes) {
              chunks.length = 0;
              await sendCancel();
              promptController.abort(new Error('llm_acp_output_limit'));
              throw new Error('llm_acp_output_limit');
            }
            chunks.push(text);
            retainedOutputBytes += chunkBytes;
          } else if (update.sessionUpdate === 'tool_call') {
            if (!distinctToolCallIds.has(update.toolCallId)) {
              distinctToolCallIds.add(update.toolCallId);
              if (distinctToolCallIds.size >= promptPolicy.toolCallAbortThreshold) {
                throw new Error('llm_acp_tool_use_limit');
              }
            }
          }
          resetIdleDeadline();
          continue;
        }
        await Promise.race([promptResult, resource.error, idleDeadline, hardDeadline]);
        return ok({ text: chunks.join('') });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    const reason = mapFailure(error);
    if (signal?.aborted) await sendCancel();
    if (reason === 'timeout' || reason === 'tool_use_limit' || reason === 'invalid_response') {
      await sendCancel();
      promptController.abort();
    }
    return fail(reason);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    session.activeSession.dispose();
  }
}

async function withConnection<T>(
  input: { spec: LlmLaunchSpec; spawn?: LlmSpawn; signal?: AbortSignal; setupTimeoutMs: number },
  run: (resource: ConnectionResource) => Promise<LlmResult<T>>,
): Promise<LlmResult<T>> {
  let resource: ConnectionResource;
  try {
    resource = connect({ spec: input.spec, spawn: input.spawn });
  } catch (error) {
    return fail(mapFailure(error));
  }

  try {
    if (input.signal?.aborted) throw new Error('llm_acp_cancelled');
    await raceWithTimeout(initialize(resource, input.signal), resource, input.setupTimeoutMs, 'initialize');
    return await run(resource);
  } catch (error) {
    return fail(mapFailure(error));
  } finally {
    await Promise.allSettled([...resource.cancelPromises.values()]);
    resource.stop();
  }
}

export function createOneShotAcpClient(input?: {
  spawn?: LlmSpawn;
  promptPolicy?: LlmPromptPolicy;
  setupTimeoutMs?: number;
}): OneShotAcpClient {
  const promptPolicy = input?.promptPolicy ?? DEFAULT_LLM_PROMPT_POLICY;
  const setupTimeoutMs = input?.setupTimeoutMs ?? LLM_ACP_SETUP_TIMEOUT_MS;

  return {
    async inspect({ spec, signal }) {
      return withConnection({ spec, spawn: input?.spawn, signal, setupTimeoutMs }, async (resource) =>
        ok(resource.inspection),
      );
    },

    async oneShotPrompt({ spec, prompt, outputMaxBytes, modelIdentifier, signal }) {
      return withConnection({ spec, spawn: input?.spawn, signal, setupTimeoutMs }, async (resource) => {
        const setup = await raceWithTimeout((async () => {
          const session = await createSession(resource, spec, signal);
          const configured = await configureSession(resource, session, modelIdentifier, signal);
          return { session, configured };
        })(), resource, setupTimeoutMs, 'session_setup');
        const { session, configured } = setup;
        if (!configured.ok) return configured;
        return promptSession(resource, session, prompt, outputMaxBytes, promptPolicy, signal);
      });
    },
  };
}
