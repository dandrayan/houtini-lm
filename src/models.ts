import {
  LM_BASE_URL, LM_MODEL, CHARS_PER_TOKEN, DEFAULT_PREFILL_TOK_PER_SEC, FALLBACK_CONTEXT_LENGTH,
} from './config.js';
import type { ModelInfo, ModelProfile } from './types.js';
import {
  apiHeaders, fetchWithTimeout, getBackend, setDetectedBackend,
} from './provider.js';
import { getLifetimeModelStats } from './session.js';
import {
  getCachedProfile,
  toModelProfile as cachedToProfile,
  getHFEnrichmentLine,
  getPromptHints,
  getPrefillSamples,
  fitPrefillLinear,
  type PromptHints,
} from './model-cache.js';

// ── Model knowledge base ─────────────────────────────────────────────

const MODEL_PROFILES: { pattern: RegExp; profile: ModelProfile }[] = [
  {
    pattern: /nemotron|nemotron_h_moe/i,
    profile: {
      family: 'NVIDIA Nemotron',
      description: 'NVIDIA\'s compact reasoning model optimised for accurate, structured responses. Strong at step-by-step logic and instruction following.',
      strengths: ['logical reasoning', 'math', 'step-by-step problem solving', 'code review', 'structured output'],
      weaknesses: ['creative writing', 'constrained generation', 'factual knowledge on niche topics'],
      bestFor: ['analysis tasks', 'code bug-finding', 'math/science questions', 'data transformation'],
    },
  },
  {
    pattern: /granite|granitehybrid/i,
    profile: {
      family: 'IBM Granite',
      description: 'IBM\'s enterprise-focused model family. Compact and efficient, designed for business and code tasks with strong instruction following.',
      strengths: ['code generation', 'instruction following', 'enterprise tasks', 'efficiency'],
      weaknesses: ['creative tasks', 'long-form generation'],
      bestFor: ['boilerplate generation', 'code explanation', 'structured Q&A'],
    },
  },
  {
    pattern: /gemma[- ]?4/i,
    profile: {
      family: 'Google Gemma 4',
      description: 'Google\'s open-weight multimodal model. Strong across code, analysis, and general tasks with fast inference.',
      strengths: ['code generation', 'code review', 'reasoning', 'instruction following', 'broad knowledge'],
      weaknesses: ['very long context tasks'],
      bestFor: ['code generation', 'code review', 'analysis', 'general delegation'],
    },
  },
  {
    pattern: /qwen3-coder|qwen3.*coder/i,
    profile: {
      family: 'Qwen3 Coder',
      description: 'Alibaba\'s code-specialised model with agentic capabilities. Excellent at code generation, review, and multi-step coding tasks.',
      strengths: ['code generation', 'code review', 'debugging', 'test writing', 'refactoring', 'multi-step reasoning'],
      weaknesses: ['non-code creative tasks'],
      bestFor: ['code generation', 'code review', 'test stubs', 'type definitions', 'refactoring'],
    },
  },
  {
    pattern: /qwen3-vl|qwen.*vl/i,
    profile: {
      family: 'Qwen3 Vision-Language',
      description: 'Alibaba\'s multimodal model handling both text and image inputs. Can analyse screenshots, diagrams, and visual content.',
      strengths: ['image understanding', 'visual Q&A', 'diagram analysis', 'OCR'],
      weaknesses: ['pure text tasks (use a text-only model instead)'],
      bestFor: ['screenshot analysis', 'UI review', 'diagram interpretation'],
    },
  },
  {
    pattern: /qwen3(?!.*coder)(?!.*vl)/i,
    profile: {
      family: 'Qwen3',
      description: 'Alibaba\'s general-purpose model with strong multilingual and reasoning capabilities. Good all-rounder.',
      strengths: ['general reasoning', 'multilingual', 'code', 'instruction following'],
      weaknesses: ['specialised code tasks (use Qwen3 Coder instead)'],
      bestFor: ['general Q&A', 'translation', 'summarisation', 'brainstorming'],
    },
  },
  {
    pattern: /llama[- ]?3/i,
    profile: {
      family: 'Meta LLaMA 3',
      description: 'Meta\'s open-weight general-purpose model. Strong baseline across tasks with large community fine-tune ecosystem.',
      strengths: ['general reasoning', 'code', 'instruction following', 'broad knowledge'],
      weaknesses: ['specialised tasks where fine-tuned models excel'],
      bestFor: ['general delegation', 'drafting', 'code review', 'Q&A'],
    },
  },
  {
    pattern: /minimax[- ]?m2/i,
    profile: {
      family: 'MiniMax M2',
      description: 'MiniMax\'s large MoE model with strong long-context and reasoning capabilities.',
      strengths: ['long context', 'reasoning', 'creative writing', 'multilingual'],
      weaknesses: ['may be slower due to model size'],
      bestFor: ['long document analysis', 'creative tasks', 'complex reasoning'],
    },
  },
  {
    pattern: /kimi[- ]?k2/i,
    profile: {
      family: 'Kimi K2',
      description: 'Moonshot AI\'s large MoE model with strong agentic and tool-use capabilities.',
      strengths: ['agentic tasks', 'tool use', 'code', 'reasoning', 'long context'],
      weaknesses: ['may be slower due to model size'],
      bestFor: ['complex multi-step tasks', 'code generation', 'reasoning chains'],
    },
  },
  {
    pattern: /gpt-oss/i,
    profile: {
      family: 'OpenAI GPT-OSS',
      description: 'OpenAI\'s open-source model release. General-purpose with strong instruction following.',
      strengths: ['instruction following', 'general reasoning', 'code'],
      weaknesses: ['less tested in open ecosystem than LLaMA/Qwen'],
      bestFor: ['general delegation', 'code tasks', 'Q&A'],
    },
  },
  {
    pattern: /glm[- ]?4/i,
    profile: {
      family: 'GLM-4',
      description: 'Zhipu AI\'s open-weight MoE model. Fast inference with strong general reasoning, multilingual support, and tool-use capabilities. Uses chain-of-thought reasoning internally. MIT licensed.',
      strengths: ['fast inference', 'general reasoning', 'tool use', 'multilingual', 'code', 'instruction following', 'chain-of-thought'],
      weaknesses: ['always emits internal reasoning (stripped automatically)', 'less tested in English-only benchmarks than LLaMA/Qwen'],
      bestFor: ['general delegation', 'fast drafting', 'code tasks', 'structured output', 'Q&A'],
    },
  },
  {
    pattern: /nomic.*embed|embed.*nomic/i,
    profile: {
      family: 'Nomic Embed',
      description: 'Text embedding model for semantic search and similarity. Not a chat model — produces vector embeddings.',
      strengths: ['text embeddings', 'semantic search', 'clustering'],
      weaknesses: ['cannot chat or generate text'],
      bestFor: ['RAG pipelines', 'semantic similarity', 'document search'],
    },
  },
  {
    pattern: /abliterated/i,
    profile: {
      family: 'Abliterated (uncensored)',
      description: 'Community fine-tune with safety guardrails removed. More permissive but may produce lower-quality or unreliable output.',
      strengths: ['fewer refusals', 'unconstrained generation'],
      weaknesses: ['may hallucinate more', 'no safety filtering', 'less tested'],
      bestFor: ['tasks where the base model refuses unnecessarily'],
    },
  },
];

/**
 * Match a model to its known profile.
 * Priority: 1) static MODEL_PROFILES (curated), 2) SQLite cache (auto-generated from HF)
 */
export function getModelProfile(model: ModelInfo): ModelProfile | undefined {
  for (const { pattern, profile } of MODEL_PROFILES) {
    if (pattern.test(model.id)) return profile;
  }
  if (model.arch) {
    for (const { pattern, profile } of MODEL_PROFILES) {
      if (pattern.test(model.arch)) return profile;
    }
  }
  return undefined;
}

/**
 * Async version that also checks SQLite cache for auto-generated profiles.
 */
export async function getModelProfileAsync(model: ModelInfo): Promise<ModelProfile | undefined> {
  const staticProfile = getModelProfile(model);
  if (staticProfile) return staticProfile;

  try {
    const cached = await getCachedProfile(model.id);
    if (cached) {
      const profile = cachedToProfile(cached);
      if (profile) return profile;
    }
  } catch {
    // Cache lookup failed — fall through
  }

  return undefined;
}

/**
 * Format a single model's full metadata for display.
 */
export async function formatModelDetail(model: ModelInfo, enrichWithHF: boolean = false): Promise<string> {
  const ctx = getContextLength(model);
  const maxCtx = getMaxContextLength(model);
  const profile = await getModelProfileAsync(model);
  const parts: string[] = [];

  parts.push(`  ${model.state === 'loaded' ? '●' : '○'} ${model.id}`);

  const meta: string[] = [];
  if (model.type) meta.push(`type: ${model.type}`);
  if (model.arch) meta.push(`arch: ${model.arch}`);
  if (model.quantization) meta.push(`quant: ${model.quantization}`);
  if (model.compatibility_type) meta.push(`format: ${model.compatibility_type}`);
  if (model.loaded_context_length && maxCtx && model.loaded_context_length !== maxCtx) {
    meta.push(`context: ${model.loaded_context_length.toLocaleString()} (max ${maxCtx.toLocaleString()})`);
  } else if (ctx) {
    meta.push(`context: ${ctx.toLocaleString()}`);
  }
  if (model.publisher) meta.push(`by: ${model.publisher}`);
  if (meta.length > 0) parts.push(`    ${meta.join(' · ')}`);

  if (model.capabilities && model.capabilities.length > 0) {
    parts.push(`    Capabilities: ${model.capabilities.join(', ')}`);
  }

  if (profile) {
    parts.push(`    ${profile.family}: ${profile.description}`);
    parts.push(`    Best for: ${profile.bestFor.join(', ')}`);
  }

  if (enrichWithHF) {
    try {
      const hfLine = await getHFEnrichmentLine(model.id);
      if (hfLine) parts.push(hfLine);
    } catch {
      // HF enrichment is best-effort — never block on failure
    }
  }

  return parts.join('\n');
}

/**
 * Fetch models with backend-aware probing.
 *   1. LM Studio /api/v0/models — richest metadata, sets backend='lmstudio'
 *   2. Ollama /api/tags           — native list, sets backend='ollama', maps to ModelInfo
 *   3. OpenAI-compatible /v1/models — generic fallback (DeepSeek, vLLM, llama.cpp, OpenRouter)
 */
export async function listModelsRaw(): Promise<ModelInfo[]> {
  // OpenRouter short-circuit — no point probing LM Studio/Ollama-specific endpoints.
  const isOpenRouter =
    (process.env.HOUTINI_LM_PROVIDER || '').toLowerCase() === 'openrouter' ||
    /openrouter\.ai/i.test(LM_BASE_URL);
  if (isOpenRouter) {
    const res = await fetchWithTimeout(
      `${LM_BASE_URL}/v1/models`,
      { headers: apiHeaders() },
    );
    if (!res.ok) throw new Error(`Failed to list OpenRouter models: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        name?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      }>;
    };
    setDetectedBackend('openrouter');
    return data.data.map((m) => ({
      id: m.id,
      object: 'model',
      type: 'llm',
      state: 'loaded',
      context_length: m.context_length,
      max_context_length: m.context_length,
      publisher: m.id.includes('/') ? m.id.split('/')[0] : undefined,
    }));
  }

  // Try LM Studio's v0 API first — returns type, arch, publisher, quantization, state
  try {
    const v0 = await fetchWithTimeout(
      `${LM_BASE_URL}/api/v0/models`,
      { headers: apiHeaders() },
    );
    if (v0.ok) {
      const data = (await v0.json()) as { data: ModelInfo[] };
      setDetectedBackend('lmstudio');
      return data.data;
    }
  } catch {
    // v0 not available — fall through
  }

  // Try Ollama's /api/tags next.
  try {
    const tags = await fetchWithTimeout(
      `${LM_BASE_URL}/api/tags`,
      { headers: apiHeaders() },
    );
    if (tags.ok) {
      const data = (await tags.json()) as {
        models?: Array<{
          name: string;
          model?: string;
          size?: number;
          details?: { family?: string; parameter_size?: string; quantization_level?: string };
        }>;
      };
      if (Array.isArray(data.models)) {
        setDetectedBackend('ollama');
        return data.models.map((m) => ({
          id: m.name,
          object: 'model',
          type: 'llm',
          arch: m.details?.family,
          quantization: m.details?.quantization_level,
          state: 'loaded',
          publisher: m.name.includes('/') ? m.name.split('/')[0] : undefined,
        }));
      }
    }
  } catch {
    // Not Ollama — fall through
  }

  // Fallback: OpenAI-compatible v1 endpoint (DeepSeek, vLLM, llama.cpp, OpenRouter)
  const res = await fetchWithTimeout(
    `${LM_BASE_URL}/v1/models`,
    { headers: apiHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
  const data = (await res.json()) as { data: ModelInfo[] };
  setDetectedBackend('openai-compat');
  return data.data;
}

export function getContextLength(model: ModelInfo): number {
  return model.loaded_context_length ?? model.max_context_length ?? model.context_length ?? model.max_model_len ?? FALLBACK_CONTEXT_LENGTH;
}

export function getMaxContextLength(model: ModelInfo): number | undefined {
  return model.max_context_length;
}

/**
 * Map model family / backend → reasoning_effort value that minimises reasoning.
 */
export function getReasoningEffortValue(_modelId: string): string | null {
  const backend = getBackend();
  if (backend === 'lmstudio') return 'none';
  if (backend === 'ollama') return 'none';
  return 'low';
}

// ── Prefill estimation ────────────────────────────────────────────────

export interface PrefillEstimate {
  inputTokens: number;
  estimatedSeconds: number;
  basis: 'linear-fit' | 'ratio' | 'default';
  fit?: { alphaMs: number; betaMsPerToken: number; r2: number; n: number };
  prefillTokPerSec?: number;
}

/**
 * Estimate prompt prefill time. Preferred method is a linear regression
 * `TTFT ≈ α + β·prompt_tokens` over recent per-model samples.
 */
export async function estimatePrefill(inputChars: number, modelId: string): Promise<PrefillEstimate> {
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);

  // 1. Linear fit over recent samples (preferred).
  try {
    const samples = await getPrefillSamples(modelId);
    const fit = fitPrefillLinear(samples);
    if (fit) {
      const estimatedMs = Math.max(0, fit.alphaMs + fit.betaMsPerToken * inputTokens);
      return {
        inputTokens,
        estimatedSeconds: estimatedMs / 1000,
        basis: 'linear-fit',
        fit,
      };
    }
  } catch {
    // Sample fetch failed — fall through to ratio estimator
  }

  // 2. Ratio fallback — uses aggregate stats already in memory.
  const stats = getLifetimeModelStats(modelId);
  if (stats && stats.ttftCalls >= 2 && stats.totalTtftMs > 0 && stats.totalPromptTokens > 0) {
    const avgPromptTokens = stats.totalPromptTokens / stats.calls;
    const avgTtftSec = (stats.totalTtftMs / stats.ttftCalls) / 1000;
    if (avgTtftSec > 0) {
      const prefillTokPerSec = avgPromptTokens / avgTtftSec;
      return {
        inputTokens,
        estimatedSeconds: inputTokens / prefillTokPerSec,
        basis: 'ratio',
        prefillTokPerSec,
      };
    }
  }

  // 3. Conservative default for unknown model/hardware.
  return {
    inputTokens,
    estimatedSeconds: inputTokens / DEFAULT_PREFILL_TOK_PER_SEC,
    basis: 'default',
    prefillTokPerSec: DEFAULT_PREFILL_TOK_PER_SEC,
  };
}

// ── Model routing ─────────────────────────────────────────────────────

export type TaskType = 'code' | 'chat' | 'analysis' | 'embedding';

export interface RoutingDecision {
  modelId: string;
  hints: PromptHints;
  suggestion?: string;
}

export async function routeToModel(taskType: TaskType, override?: string): Promise<RoutingDecision> {
  const pinned = override || LM_MODEL;
  if (pinned) {
    const hints = getPromptHints(pinned);
    return { modelId: pinned, hints };
  }

  let models: ModelInfo[];
  try {
    models = await listModelsRaw();
  } catch {
    const hints = getPromptHints(LM_MODEL);
    return { modelId: LM_MODEL || '', hints };
  }

  const loaded = models.filter((m) => m.state === 'loaded' || !m.state);
  const available = models.filter((m) => m.state === 'not-loaded');

  if (loaded.length === 0) {
    const hints = getPromptHints(LM_MODEL);
    return { modelId: LM_MODEL || '', hints };
  }

  let bestModel = loaded[0];
  let bestScore = -1;

  for (const model of loaded) {
    const hints = getPromptHints(model.id, model.arch);
    let score = (hints.bestTaskTypes ?? []).includes(taskType) ? 10 : 0;
    const profile = getModelProfile(model);
    if (taskType === 'code' && profile?.family.toLowerCase().includes('coder')) score += 5;
    if (taskType === 'analysis') {
      const ctx = getContextLength(model);
      if (ctx && ctx > 100000) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestModel = model;
    }
  }

  const hints = getPromptHints(bestModel.id, bestModel.arch);
  const result: RoutingDecision = { modelId: bestModel.id, hints };

  if (!(hints.bestTaskTypes ?? []).includes(taskType)) {
    const better = available.find((m) => {
      const mHints = getPromptHints(m.id, m.arch);
      return (mHints.bestTaskTypes ?? []).includes(taskType);
    });
    if (better) {
      const label = taskType === 'code' ? 'code tasks'
        : taskType === 'analysis' ? 'analysis'
        : taskType === 'embedding' ? 'embeddings'
        : 'this kind of task';
      result.suggestion = `💡 ${better.id} is downloaded and better suited for ${label} — ask the user to load it in LM Studio.`;
    }
  }

  return result;
}
