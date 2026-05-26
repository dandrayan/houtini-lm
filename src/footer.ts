import { QUIET_MODE } from './config.js';
import type { StreamingResult } from './types.js';
import { recordUsage, sessionSummary, isFirstBenchmarkedCall } from './session.js';

// ── Quality metadata ─────────────────────────────────────────────────
// Provides structured quality signals in every response so Claude (or any
// orchestrator) can make informed trust decisions about the local LLM output.

export interface QualitySignal {
  truncated: boolean;
  prefillStall: boolean;
  finishReason: string;
  thinkBlocksStripped: boolean;
  thinkStripFallback: boolean;
  reasoningFallback: boolean;
  estimatedTokens: boolean;
  contentLength: number;
  generationMs: number;
  tokPerSec: number | null;
}

export function assessQuality(resp: StreamingResult, rawContent: string): QualitySignal {
  const hadThinkBlocks = /<think>/.test(rawContent);
  const estimated = !resp.usage && resp.content.length > 0;
  const tokPerSec = resp.usage && resp.generationMs > 50
    ? resp.usage.completion_tokens / (resp.generationMs / 1000)
    : null;

  return {
    truncated: resp.truncated,
    prefillStall: resp.prefillStall ?? false,
    finishReason: resp.finishReason || 'unknown',
    thinkBlocksStripped: hadThinkBlocks,
    thinkStripFallback: resp.thinkStripFallback ?? false,
    reasoningFallback: resp.reasoningFallback ?? false,
    estimatedTokens: estimated,
    contentLength: resp.content.length,
    generationMs: resp.generationMs,
    tokPerSec,
  };
}

export function formatQualityLine(quality: QualitySignal): string {
  const flags: string[] = [];
  if (quality.prefillStall) flags.push('PREFILL-STALL (no tokens received — input may be too large for this model/hardware)');
  else if (quality.truncated) flags.push('TRUNCATED');
  if (quality.reasoningFallback) flags.push('reasoning-only (model exhausted output budget before emitting visible content — showing raw reasoning)');
  else if (quality.thinkStripFallback) flags.push('think-strip-empty (showing raw reasoning — model ignored enable_thinking:false)');
  else if (quality.thinkBlocksStripped) flags.push('think-blocks-stripped');
  if (quality.estimatedTokens) flags.push('tokens-estimated');
  if (quality.finishReason === 'length') flags.push('hit-max-tokens');
  if (flags.length === 0) return '';
  return `Quality: ${flags.join(', ')}`;
}

/**
 * Format a footer line for streaming results showing model, usage, and truncation status.
 *
 * Layout:
 *   ---
 *   Model: ... | prompt→completion tokens | perf | extra | quality
 *   📊 [first-call benchmark line, only on the first measured call per model]
 *   💰 Claude quota saved this session: ...
 */
export function formatFooter(resp: StreamingResult, extra?: string): string {
  recordUsage(resp);
  if (QUIET_MODE) return '';

  const parts: string[] = [];
  if (resp.model) parts.push(`Model: ${resp.model}`);
  if (resp.usage) {
    const reasoningTokens = resp.usage.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoningTokens === 'number' && reasoningTokens > 0) {
      const visible = resp.usage.completion_tokens - reasoningTokens;
      parts.push(`${resp.usage.prompt_tokens}→${resp.usage.completion_tokens} tokens (${reasoningTokens} reasoning / ${visible} visible)`);
    } else {
      parts.push(`${resp.usage.prompt_tokens}→${resp.usage.completion_tokens} tokens`);
    }
  } else if (resp.content.length > 0) {
    const estTokens = Math.ceil(resp.content.length / 4);
    parts.push(`~${estTokens} tokens (estimated)`);
  }

  const perfParts: string[] = [];
  if (resp.ttftMs !== undefined) perfParts.push(`TTFT: ${resp.ttftMs}ms`);
  let tokPerSec = 0;
  if (resp.usage && resp.generationMs > 50) {
    tokPerSec = resp.usage.completion_tokens / (resp.generationMs / 1000);
    perfParts.push(`${tokPerSec.toFixed(1)} tok/s`);
  }
  if (resp.generationMs) perfParts.push(`${(resp.generationMs / 1000).toFixed(1)}s`);
  if (perfParts.length > 0) parts.push(perfParts.join(', '));

  if (extra) parts.push(extra);

  const quality = assessQuality(resp, resp.rawContent);
  const qualityLine = formatQualityLine(quality);
  if (qualityLine) parts.push(qualityLine);
  if (resp.truncated) parts.push('⚠ TRUNCATED (soft timeout — partial result)');

  const benchmarkLine = isFirstBenchmarkedCall(resp.model, tokPerSec)
    ? `📊 First measured call on ${resp.model}: ${tokPerSec.toFixed(1)} tok/s${resp.ttftMs !== undefined ? `, ${resp.ttftMs}ms to first token` : ''} — use this to gauge whether to delegate longer tasks.`
    : '';
  const sessionLine = sessionSummary();

  if (parts.length === 0 && !benchmarkLine && !sessionLine) return '';

  const lines: string[] = [`\n\n---${parts.length > 0 ? `\n${parts.join(' | ')}` : ''}`];
  if (benchmarkLine) lines.push(benchmarkLine);
  if (sessionLine) lines.push(sessionLine);

  return lines.join('\n');
}
