export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamingResult {
  content: string;
  /** Raw content before think-block stripping (for quality assessment) */
  rawContent: string;
  /** Reasoning content streamed via OpenAI vendor extension delta.reasoning_content */
  reasoningContent?: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** OpenAI: how many of the completion tokens were reasoning (hidden) */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  finishReason: string;
  truncated: boolean;
  /** Time to first token in milliseconds */
  ttftMs?: number;
  /** Total generation time in milliseconds */
  generationMs: number;
  /** True when think-block stripping left nothing and we fell back to raw content */
  thinkStripFallback?: boolean;
  /** True when no visible content arrived and we fell back to reasoning_content */
  reasoningFallback?: boolean;
  /** Truncation caused by prefill stall (no chunks received) vs mid-stream stall */
  prefillStall?: boolean;
}

/** OpenAI-compatible response_format for structured output */
export interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: {
    name: string;
    strict?: boolean | string;
    schema: Record<string, unknown>;
  };
}

export interface ModelInfo {
  id: string;
  object?: string;
  type?: string;              // "llm" | "vlm" | "embeddings"
  publisher?: string;          // e.g. "nvidia", "qwen", "ibm"
  arch?: string;               // e.g. "nemotron_h_moe", "qwen3moe", "llama"
  compatibility_type?: string; // "gguf" | "mlx"
  quantization?: string;       // e.g. "Q4_K_M", "BF16", "MXFP4"
  state?: string;              // "loaded" | "not-loaded"
  max_context_length?: number; // model's maximum context (v0 API)
  loaded_context_length?: number; // actual context configured when loaded
  capabilities?: string[];     // e.g. ["tool_use"]
  context_length?: number;     // v1 API fallback
  max_model_len?: number;      // vLLM fallback
  owned_by?: string;
  [key: string]: unknown;
}

// ── Model knowledge base ─────────────────────────────────────────────
// Maps known model families (matched by ID or architecture) to human-readable
// descriptions and capability profiles.

export interface ModelProfile {
  family: string;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestFor: string[];
  size?: string; // e.g. "3B", "70B" — only if consistently one size
}
