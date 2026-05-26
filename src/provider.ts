import {
  LM_BASE_URL, LM_PASSWORD, HOUTINI_LM_PROVIDER, CONNECT_TIMEOUT_MS,
} from './config.js';

export type Backend = 'lmstudio' | 'ollama' | 'openai-compat' | 'openrouter';
let detectedBackend: Backend | null = null;

export function getBackend(): Backend {
  return detectedBackend ?? 'openai-compat';
}

export function setDetectedBackend(b: Backend): void {
  detectedBackend = b;
}

export interface ProviderProfile {
  /** Send OpenRouter-style attribution headers (HTTP-Referer, X-Title). */
  extraHeaders: Record<string, string>;
  /** True for local servers that run a single model and should not be
   *  hammered with parallel requests. False for remote providers that
   *  benefit from parallelism. */
  serialiseInference: boolean;
  /** Retry with backoff on 429/5xx for remote providers. */
  retryOnRateLimit: boolean;
  /** How reasoning-model output is returned.
   *   - 'think-blocks': inline `<think>…</think>` in content (local models)
   *   - 'openrouter-field': separate `message.reasoning` field
   *   - 'none': no reasoning handling needed */
  reasoningStyle: 'think-blocks' | 'openrouter-field' | 'none';
}

export function getProviderProfile(): ProviderProfile {
  const backend = getBackend();
  const isOpenRouter =
    backend === 'openrouter' ||
    HOUTINI_LM_PROVIDER === 'openrouter' ||
    /openrouter\.ai/i.test(LM_BASE_URL);

  if (isOpenRouter) {
    return {
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/houtini-ai/lm',
        'X-Title': 'houtini-lm',
      },
      serialiseInference: false,
      retryOnRateLimit: true,
      reasoningStyle: 'openrouter-field',
    };
  }

  return {
    extraHeaders: {},
    serialiseInference: true,
    retryOnRateLimit: false,
    reasoningStyle: 'think-blocks',
  };
}

export function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LM_PASSWORD) h['Authorization'] = `Bearer ${LM_PASSWORD}`;
  const profile = getProviderProfile();
  for (const [k, v] of Object.entries(profile.extraHeaders)) h[k] = v;
  return h;
}

// ── Request semaphore ────────────────────────────────────────────────
// Most local LLM servers run a single model and queue parallel requests,
// which stacks timeouts and wastes the 55s budget. This semaphore ensures
// only one inference call runs at a time; others wait in line.

let inferenceLock: Promise<void> = Promise.resolve();

export function withInferenceLock<T>(fn: () => Promise<T>): Promise<T> {
  // Remote providers (OpenRouter etc.) benefit from parallelism and do
  // their own rate-limit handling; serialising here just throttles us.
  if (!getProviderProfile().serialiseInference) return fn();
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const wait = inferenceLock;
  inferenceLock = next;
  return wait.then(fn).finally(() => release!());
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const asInt = parseInt(headerValue, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        try { await res.body?.cancel(); } catch { /* ignore */ }
        const base = 400 * (attempt + 1);
        const target = Math.min(Math.max(base, retryAfter ?? 0), 10_000);
        const delay = Math.round(target * (0.5 + Math.random())); // 0.5×..1.5×
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const delay = Math.round(400 * (attempt + 1) * (0.5 + Math.random()));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function timedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | 'timeout'> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
