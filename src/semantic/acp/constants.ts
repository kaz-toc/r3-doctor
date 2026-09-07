/** Maximum silence allowed while one provider prompt is active. */
export const LLM_PROMPT_IDLE_TIMEOUT_MS = 60_000;

/** Absolute wall-clock limit for one provider prompt. */
export const LLM_PROMPT_HARD_TIMEOUT_MS = 180_000;

/** Maximum silence allowed while initializing ACP or creating/configuring a session. */
export const LLM_ACP_SETUP_TIMEOUT_MS = 60_000;

/** Abort on the first distinct tool call observed in one prompt. */
export const LLM_TOOL_CALL_ABORT_THRESHOLD = 1;

/** Maximum retained response bytes from one prompt. */
export const LLM_PROMPT_OUTPUT_MAX_BYTES = 256 * 1024;
