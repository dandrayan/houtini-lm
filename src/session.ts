import {
  recordPerformance,
  getAllPerformance,
  getLifetimeTotals,
  recordPrefillSample,
} from './model-cache.js';
import type { StreamingResult } from './types.js';

// ── Session-level token accounting ───────────────────────────────────
// Tracks cumulative tokens offloaded to the local LLM across all calls
// in this session. Shown in every response footer so Claude can reason
// about cost savings and continue delegating strategically.

export const session = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  /** Per-model performance tracking for routing insights */
  modelStats: new Map<string, { calls: number; ttftCalls: number; perfCalls: number; totalTtftMs: number; totalTokPerSec: number }>(),
};

// Lifetime mirror — kept in sync with the SQLite `model_performance` table
// so the footer/discover path stays synchronous. Hydrated once at startup
// from `getAllPerformance()`, then updated in-memory alongside every DB
// write in `recordUsage`. Also updated after the async DB write completes
// so counters can only ever run a tick behind, never ahead.
export const lifetime = {
  totalCalls: 0,
  totalTokens: 0,
  modelsUsed: 0,
  firstSeenAt: null as number | null,
  /** Per-model lifetime stats — same shape as session.modelStats for easy formatting. */
  modelStats: new Map<string, { calls: number; ttftCalls: number; perfCalls: number; totalTtftMs: number; totalTokPerSec: number; totalPromptTokens: number; firstSeenAt: number; lastUsedAt: number }>(),
};

/** Accessor used by estimatePrefill in models.ts to read lifetime stats without a circular dep. */
export function getLifetimeModelStats(modelId: string) {
  return lifetime.modelStats.get(modelId);
}

export async function hydrateLifetimeFromDb(): Promise<void> {
  try {
    const totals = await getLifetimeTotals();
    lifetime.totalCalls = totals.totalCalls;
    lifetime.totalTokens = totals.totalTokens;
    lifetime.modelsUsed = totals.modelsUsed;
    lifetime.firstSeenAt = totals.firstSeenAt;

    const rows = await getAllPerformance();
    lifetime.modelStats.clear();
    for (const r of rows) {
      lifetime.modelStats.set(r.modelId, {
        calls: r.totalCalls,
        ttftCalls: r.ttftCalls,
        perfCalls: r.perfCalls,
        totalTtftMs: r.totalTtftMs,
        totalTokPerSec: r.totalTokPerSec,
        totalPromptTokens: r.totalPromptTokens,
        firstSeenAt: r.firstSeenAt,
        lastUsedAt: r.lastUsedAt,
      });
    }
  } catch (err) {
    process.stderr.write(`[houtini-lm] Lifetime hydration failed (stats will build from this session): ${err}\n`);
  }
}

export function recordUsage(resp: StreamingResult) {
  session.calls++;
  const promptTokens = resp.usage?.prompt_tokens ?? 0;
  let completionTokens = resp.usage?.completion_tokens ?? 0;
  const reasoningTokens = resp.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (resp.usage) {
    session.promptTokens += promptTokens;
    session.completionTokens += completionTokens;
  } else if (resp.content.length > 0) {
    // Estimate when usage is missing (truncated responses)
    const est = Math.ceil(resp.content.length / 4);
    completionTokens = est;
    session.completionTokens += est;
  }

  // Tok/s used by both session and lifetime stats
  const tokPerSec = resp.usage && resp.generationMs > 50
    ? (resp.usage.completion_tokens / (resp.generationMs / 1000))
    : 0;

  // Session per-model (unchanged behaviour)
  if (resp.model) {
    const existing = session.modelStats.get(resp.model) || { calls: 0, ttftCalls: 0, perfCalls: 0, totalTtftMs: 0, totalTokPerSec: 0 };
    existing.calls++;
    if (resp.ttftMs) {
      existing.totalTtftMs += resp.ttftMs;
      existing.ttftCalls++;
    }
    if (tokPerSec > 0) {
      existing.perfCalls++;
      existing.totalTokPerSec += tokPerSec;
    }
    session.modelStats.set(resp.model, existing);
  }

  // Lifetime mirror + SQLite write — fire-and-forget so a DB hiccup can't
  // stall a tool response. The in-memory mirror is updated synchronously so
  // the footer and discover output reflect this call immediately.
  if (resp.model && (promptTokens > 0 || completionTokens > 0)) {
    const now = Date.now();
    const wasFirstEver = !lifetime.modelStats.has(resp.model);
    const lExisting = lifetime.modelStats.get(resp.model) || {
      calls: 0, ttftCalls: 0, perfCalls: 0, totalTtftMs: 0, totalTokPerSec: 0, totalPromptTokens: 0,
      firstSeenAt: now, lastUsedAt: now,
    };
    lExisting.calls++;
    if (resp.ttftMs) {
      lExisting.totalTtftMs += resp.ttftMs;
      lExisting.ttftCalls++;
    }
    if (tokPerSec > 0) {
      lExisting.perfCalls++;
      lExisting.totalTokPerSec += tokPerSec;
    }
    lExisting.totalPromptTokens += promptTokens;
    lExisting.lastUsedAt = now;
    lifetime.modelStats.set(resp.model, lExisting);

    lifetime.totalCalls++;
    lifetime.totalTokens += promptTokens + completionTokens;
    if (wasFirstEver) {
      lifetime.modelsUsed++;
      if (lifetime.firstSeenAt === null) lifetime.firstSeenAt = now;
    }

    recordPerformance(resp.model, {
      ttftMs: resp.ttftMs,
      tokPerSec: tokPerSec > 0 ? tokPerSec : undefined,
      promptTokens,
      completionTokens,
      reasoningTokens,
    }).catch((err) => {
      process.stderr.write(`[houtini-lm] Performance write failed (continuing): ${err}\n`);
    });

    // Record (prompt_tokens, TTFT) pair for the linear-fit prefill estimator.
    if (resp.ttftMs && promptTokens > 0) {
      recordPrefillSample(resp.model, promptTokens, resp.ttftMs).catch((err) => {
        process.stderr.write(`[houtini-lm] Prefill sample write failed (continuing): ${err}\n`);
      });
    }
  }
}

export function sessionSummary(): string {
  const total = session.promptTokens + session.completionTokens;
  if (session.calls === 0 && lifetime.totalCalls === 0) return '';

  const callWord = (n: number) => (n === 1 ? 'call' : 'calls');
  const sessionPart = session.calls > 0
    ? `this session: ${total.toLocaleString()} tokens / ${session.calls} ${callWord(session.calls)}`
    : 'this session: 0 tokens';

  if (lifetime.totalCalls > 0) {
    return `💰 Claude quota saved — ${sessionPart} · lifetime: ${lifetime.totalTokens.toLocaleString()} tokens / ${lifetime.totalCalls} ${callWord(lifetime.totalCalls)}`;
  }
  return `💰 Claude quota saved ${sessionPart}`;
}

/**
 * Return true when this response is the first one with measurable perf stats
 * for its model in the current session.
 */
export function isFirstBenchmarkedCall(modelId: string, tokPerSec: number): boolean {
  if (!modelId || tokPerSec <= 0) return false;
  const stats = session.modelStats.get(modelId);
  // After recordUsage has run, perfCalls === 1 means this was the first measured call.
  return !!stats && stats.perfCalls === 1;
}
