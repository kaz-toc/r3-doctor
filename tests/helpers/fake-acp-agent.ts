import { PassThrough } from 'node:stream';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import type {
  ClientCapabilities,
  InitializeResponse,
  PromptRequest,
} from '@agentclientprotocol/sdk';

import type { LlmProcess, LlmSpawn } from '../../src/semantic/acp/process-port.js';

export type FakeAcpAgentScript = {
  initialize: InitializeResponse;
  hangInitialize?: boolean;
  hangSessionSetup?: boolean;
  protocolVersionMismatch?: boolean;
  promptChunks?: readonly string[];
  promptToolCall?: boolean;
};

export type FakeAcpAgentHandle = {
  spawn: LlmSpawn;
  initializeRequests: Array<{ clientCapabilities: ClientCapabilities }>;
  promptRequests: PromptRequest[];
  killCount: number;
  spawnCount: number;
};

export function fakeAcpAgent(script: FakeAcpAgentScript): FakeAcpAgentHandle {
  const handle: FakeAcpAgentHandle = {
    spawn: () => {
      throw new Error('fakeAcpAgent spawn not initialized');
    },
    initializeRequests: [],
    promptRequests: [],
    killCount: 0,
    spawnCount: 0,
  };

  handle.spawn = () => {
    handle.spawnCount += 1;
    const agentStdin = new PassThrough();
    const agentStdout = new PassThrough();
    let killed = false;
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

    const emitExit = () => {
      if (killed) return;
      killed = true;
      agentStdin.end();
      agentStdout.end();
      for (const listener of exitListeners) listener(1, null);
    };

    const agentApp = acp
      .agent({ name: 'fake-acp-agent' })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => {
        handle.initializeRequests.push({ clientCapabilities: params.clientCapabilities ?? {} });
        if (script.hangInitialize) {
          return new Promise<InitializeResponse>(() => undefined);
        }
        if (script.protocolVersionMismatch) {
          return { ...script.initialize, protocolVersion: script.initialize.protocolVersion + 999 };
        }
        return script.initialize;
      })
      .onRequest(acp.methods.agent.session.new, () => {
        if (script.hangSessionSetup) {
          return new Promise<{ sessionId: string }>(() => undefined);
        }
        return { sessionId: 'session-default' };
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        handle.promptRequests.push(params);
        if (script.promptToolCall) {
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'Run command',
              kind: 'execute',
              status: 'pending',
            },
          });
        }
        for (const text of script.promptChunks ?? []) {
          await client.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          });
        }
        return { stopReason: 'end_turn' };
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(agentStdout) as WritableStream<Uint8Array>,
      Readable.toWeb(agentStdin) as ReadableStream<Uint8Array>,
    );
    agentApp.connect(stream);

    const process: LlmProcess = {
      stdin: agentStdin,
      stdout: agentStdout,
      kill: () => {
        handle.killCount += 1;
        emitExit();
        return true;
      },
      once(event, listener) {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
        return process;
      },
    };

    return process;
  };

  return handle;
}
