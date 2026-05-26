import {
  LM_BASE_URL, LM_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE, DISABLE_THINKING,
  INFERENCE_CONNECT_TIMEOUT_MS, SOFT_TIMEOUT_MS, READ_CHUNK_TIMEOUT_MS,
  PREFILL_TIMEOUT_MS, PREFILL_KEEPALIVE_MS,
} from './config.js';
import type { ChatMessage, StreamingResult, ResponseFormat, ModelInfo } from './types.js';
import {
  withInferenceLock, apiHeaders, fetchWithTimeout, fetchWithRetry, timedRead,
  getProviderProfile,
} from './provider.js';
import { listModelsRaw, getContextLength, getReasoningEffortValue } from './models.js';
import { getThinkingSupport } from './model-cache.js';

// Injected by index.ts after the MCP server is created to avoid a circular dep.
type NotifyFn = (params: {
  method: string;
  params: { progressToken: string | number; progress: number; message: string };
}) => Promise<void>;

let notifyFn: NotifyFn | null = null;

export function setNotifyFn(fn: NotifyFn): void {
  notifyFn = fn;
}

/** Get the first loaded model's info for context-aware defaults. */
export async function getActiveModel(): Promise<ModelInfo | null> {
  try {
    const models = await listModelsRaw();
    return models.find((m: ModelInfo) => m.state === 'loaded') ?? models[0] ?? null;
  } catch { return null; }
}

/**
 * Streaming chat completion with soft timeout.
 *
 * Uses SSE streaming (`stream: true`) so tokens arrive incrementally.
 * If we approach the MCP SDK's ~60s timeout (soft limit at 55s), we
 * return whatever content we have so far with `truncated: true`.
 */
export async function chatCompletionStreaming(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; model?: string; responseFormat?: ResponseFormat; progressToken?: string | number } = {},
): Promise<StreamingResult> {
  return withInferenceLock(() => chatCompletionStreamingInner(messages, options));
}

async function chatCompletionStreamingInner(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; model?: string; responseFormat?: ResponseFormat; progressToken?: string | number } = {},
): Promise<StreamingResult> {
  let resolvedModel: string | undefined = options.model || LM_MODEL || undefined;
  let activeModelCached: ModelInfo | null = null;
  const resolveActive = async () => {
    if (activeModelCached === null) activeModelCached = await getActiveModel();
    return activeModelCached;
  };
  if (!resolvedModel) {
    const active = await resolveActive();
    if (active) resolvedModel = active.id;
  }

  let effectiveMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!options.maxTokens) {
    const activeModel = await resolveActive();
    if (activeModel) {
      const ctx = getContextLength(activeModel);
      effectiveMaxTokens = Math.floor(ctx * 0.25);
    }
  }

  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: effectiveMaxTokens,
    max_completion_tokens: effectiveMaxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (resolvedModel) {
    body.model = resolvedModel;
  }
  if (options.responseFormat) {
    body.response_format = options.responseFormat;
  }

  // Handle thinking/reasoning models.
  const modelId = (resolvedModel || '').toString();
  const profile = getProviderProfile();

  if (profile.reasoningStyle === 'openrouter-field') {
    body.reasoning = { exclude: true };
    const beforeInflation = effectiveMaxTokens;
    const inflated = Math.max(beforeInflation * 4, beforeInflation + 2000);
    body.max_tokens = inflated;
    body.max_completion_tokens = inflated;
    process.stderr.write(`[houtini-lm] OpenRouter model ${modelId || '(unspecified)'}: reasoning.exclude=true, max_tokens inflated ${beforeInflation} → ${inflated}\n`);
  } else if (modelId) {
    const thinking = await getThinkingSupport(modelId);
    if (thinking?.supportsThinkingToggle) {
      body.enable_thinking = false;
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs as Record<string, unknown> | undefined ?? {}),
        enable_thinking: false,
      };
      const reasoningValue = getReasoningEffortValue(modelId);
      if (reasoningValue !== null) {
        body.reasoning_effort = reasoningValue;
      }
      const beforeInflation = effectiveMaxTokens;
      const inflated = Math.max(beforeInflation * 4, beforeInflation + 2000);
      body.max_tokens = inflated;
      body.max_completion_tokens = inflated;
      process.stderr.write(`[houtini-lm] Thinking model ${modelId}: reasoning_effort=${reasoningValue ?? '(omitted)'}, enable_thinking=false, max_tokens inflated ${beforeInflation} → ${inflated}\n`);
    }
  }

  if (DISABLE_THINKING) {
    body.enable_thinking = false;
    body.chat_template_kwargs = {
      ...(body.chat_template_kwargs as Record<string, unknown> | undefined ?? {}),
      enable_thinking: false,
    };
  }

  const startTime = Date.now();

  let progressSeq = 0;
  const sendProgress = (message: string) => {
    if (options.progressToken === undefined) return;
    progressSeq++;
    notifyFn?.({
      method: 'notifications/progress',
      params: {
        progressToken: options.progressToken,
        progress: progressSeq,
        message,
      },
    }).catch(() => { /* best-effort — don't break streaming */ });
  };

  sendProgress('Connecting to model...');

  const preFetchTimer: ReturnType<typeof setInterval> = setInterval(() => {
    const waitedMs = Date.now() - startTime;
    sendProgress(`Connecting to model... (${(waitedMs / 1000).toFixed(0)}s)`);
  }, PREFILL_KEEPALIVE_MS);

  let res: Response;
  try {
    res = profile.retryOnRateLimit
      ? await fetchWithRetry(
          `${LM_BASE_URL}/v1/chat/completions`,
          { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) },
          INFERENCE_CONNECT_TIMEOUT_MS,
          2,
        )
      : await fetchWithTimeout(
          `${LM_BASE_URL}/v1/chat/completions`,
          { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) },
          INFERENCE_CONNECT_TIMEOUT_MS,
        );
  } finally {
    clearInterval(preFetchTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LM Studio API error ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error('Response body is null — streaming not supported by endpoint');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoning = '';
  let model = '';
  let usage: StreamingResult['usage'];
  let finishReason = '';
  let truncated = false;
  let prefillStall = false;
  let buffer = '';
  let ttftMs: number | undefined;
  let firstChunkReceived = false;

  const keepAliveTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (firstChunkReceived) return;
    const waitedMs = Date.now() - startTime;
    sendProgress(`Waiting for model... (${(waitedMs / 1000).toFixed(0)}s, still in prefill)`);
  }, PREFILL_KEEPALIVE_MS);

  try {
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > SOFT_TIMEOUT_MS) {
        truncated = true;
        process.stderr.write(`[houtini-lm] Soft timeout at ${elapsed}ms, returning ${content.length} chars of partial content\n`);
        break;
      }

      const remaining = SOFT_TIMEOUT_MS - elapsed;
      const perChunkCeiling = firstChunkReceived ? READ_CHUNK_TIMEOUT_MS : PREFILL_TIMEOUT_MS;
      const chunkTimeout = Math.min(perChunkCeiling, remaining);
      const result = await timedRead(reader, chunkTimeout);

      if (result === 'timeout') {
        truncated = true;
        prefillStall = !firstChunkReceived;
        process.stderr.write(`[houtini-lm] ${prefillStall ? 'Prefill' : 'Mid-stream'} timeout, returning ${content.length} chars of partial content\n`);
        break;
      }

      if (result.done) break;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
      }

      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          if (json.model) model = json.model;

          const delta = json.choices?.[0]?.delta;

          // Reasoning channel: delta.reasoning_content (LM Studio, DeepSeek) or delta.reasoning (Ollama)
          const reasoningChunk = (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0)
            ? delta.reasoning_content
            : (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0)
              ? delta.reasoning
              : '';
          if (reasoningChunk) {
            reasoning += reasoningChunk;
            sendProgress(`Thinking... (${reasoning.length} chars of reasoning)`);
          }

          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            content += delta.content;
            sendProgress(`Streaming... ${content.length} chars`);
          }

          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;

          if (json.usage) usage = json.usage;
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    // Flush remaining buffer — the usage chunk often arrives in the final SSE message.
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6));
          if (json.model) model = json.model;
          const delta = json.choices?.[0]?.delta;
          const finalReasoningChunk = (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0)
            ? delta.reasoning_content
            : (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0)
              ? delta.reasoning
              : '';
          if (finalReasoningChunk) {
            reasoning += finalReasoningChunk;
          }
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            content += delta.content;
          }
          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (json.usage) usage = json.usage;
        } catch (e) {
          process.stderr.write(`[houtini-lm] Unflushed buffer parse failed (${buffer.length} bytes): ${e}\n`);
        }
      }
    }
  } finally {
    clearInterval(keepAliveTimer);
    try {
      await Promise.race([
        reader.cancel().catch(() => { /* ignore */ }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch { /* never propagate cleanup errors */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const generationMs = Date.now() - startTime;

  // Strip <think>...</think> reasoning blocks from models that always emit them inline.
  let cleanContent = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');   // closed blocks
  cleanContent = cleanContent.replace(/^<think>\s*/, '');                    // orphaned opening tag
  cleanContent = cleanContent.replace(/^[\s\S]*?<\/think>\s*/, '');          // orphaned closing tag
  cleanContent = cleanContent.trim();

  let thinkStripFallback = false;
  let reasoningFallback = false;
  if (!cleanContent) {
    if (content.trim()) {
      thinkStripFallback = true;
      cleanContent = content.trim();
    } else if (reasoning.trim()) {
      reasoningFallback = true;
      cleanContent =
        '[No visible output — the model spent its entire output budget on reasoning_content before emitting any content. ' +
        'Raw reasoning below so you can see what it was doing:]\n\n' +
        reasoning.trim();
    }
  }

  return {
    content: cleanContent,
    rawContent: content,
    reasoningContent: reasoning || undefined,
    model,
    usage,
    finishReason,
    truncated,
    ttftMs,
    generationMs,
    thinkStripFallback,
    reasoningFallback,
    prefillStall,
  };
}
