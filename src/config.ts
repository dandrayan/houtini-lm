// Env var naming: HOUTINI_LM_* is the preferred namespace now that we
// support more than just LM Studio. The legacy LM_STUDIO_* names remain
// accepted indefinitely so existing users don't need to change anything.
export const LM_BASE_URL =
  process.env.HOUTINI_LM_ENDPOINT_URL ||
  process.env.LM_STUDIO_URL ||
  'http://localhost:1234';
export const LM_MODEL =
  process.env.HOUTINI_LM_MODEL ||
  process.env.LM_STUDIO_MODEL ||
  '';
export const LM_PASSWORD =
  process.env.HOUTINI_LM_API_KEY ||
  process.env.LM_STUDIO_PASSWORD ||
  process.env.LM_PASSWORD ||
  process.env.OPENROUTER_API_KEY ||
  '';
export const HOUTINI_LM_PROVIDER = (process.env.HOUTINI_LM_PROVIDER || '').toLowerCase();
export const DEFAULT_MAX_TOKENS = 16384;             // fallback when model context is unknown — overridden by dynamic calculation below
export const DEFAULT_TEMPERATURE = 0.3;
export const CONNECT_TIMEOUT_MS = 5000;
export const INFERENCE_CONNECT_TIMEOUT_MS = 600_000; // wait for response headers — on large inputs LM Studio may hold headers until first token is ready
export const SOFT_TIMEOUT_MS = 300_000;             // 5 min — progress notifications reset MCP client timeout, so this is a safety net not the primary limit
export const READ_CHUNK_TIMEOUT_MS = 30_000;        // max wait for a single SSE chunk mid-stream
export const PREFILL_TIMEOUT_MS = 300_000;          // max wait for the FIRST chunk — prompt prefill on slow hardware with big inputs can legitimately take 1-2 min
export const PREFILL_KEEPALIVE_MS = 10_000;         // fire a progress notification every N ms while waiting for prefill to finish
export const FALLBACK_CONTEXT_LENGTH = parseInt(
  process.env.HOUTINI_LM_CONTEXT_WINDOW || process.env.LM_CONTEXT_WINDOW || '100000',
  10,
);

/** Rough chars→tokens ratio used for pre-flight estimates. */
export const CHARS_PER_TOKEN = 4;

/** Conservative default prefill rate when no per-model measurement exists. */
export const DEFAULT_PREFILL_TOK_PER_SEC = 300;

/** Hard ceiling for when we refuse to send the call. */
const _rawThreshold = process.env.HOUTINI_LM_PREFILL_THRESHOLD_SEC !== undefined
  ? parseFloat(process.env.HOUTINI_LM_PREFILL_THRESHOLD_SEC)
  : NaN;
export const PREFILL_REFUSE_THRESHOLD_SEC = Number.isNaN(_rawThreshold) ? 45 : _rawThreshold;

/** Skip the preflight check entirely. */
export const SKIP_PREFLIGHT_GLOBAL = process.env.HOUTINI_LM_SKIP_PREFLIGHT === '1';

/** Suppress the stats/perf footer appended to every tool response. */
export const QUIET_MODE = process.env.HOUTINI_LM_QUIET === '1';

/** Force enable_thinking:false on every request regardless of model auto-detection. */
export const DISABLE_THINKING = process.env.HOUTINI_LM_DISABLE_THINKING === '1';

/** Soft warning threshold — we proceed but log a stderr warning. */
export const PREFILL_WARN_THRESHOLD_SEC = 25;
