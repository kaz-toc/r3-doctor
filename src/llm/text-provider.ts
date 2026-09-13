export type LlmTextRequest = {
  prompt: string;
  outputMaxBytes: number;
  /** Epoch milliseconds by which the call, including process cleanup, must finish. */
  deadlineAt: number;
  signal: AbortSignal;
};

export type LlmTextResult =
  | {
      ok: true;
      text: string;
      agentVersion: string | null;
      resolvedModel: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { ok: false; reason: string };

/** Purpose-neutral, one-shot text completion. Implementations never expose files, terminals, or tools. */
export type LlmTextPort = {
  complete(input: LlmTextRequest): Promise<LlmTextResult>;
};
