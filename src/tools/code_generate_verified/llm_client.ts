import type { LlmClient, LlmRequest } from './types.js';

const LM_BASE_URL =
  process.env['HOUTINI_LM_ENDPOINT_URL'] ||
  process.env['LM_STUDIO_URL'] ||
  'http://localhost:1234';

export const atheneLlmClient: LlmClient = async (req: LlmRequest) => {
  const start = Date.now();
  const body = {
    model: req.model,
    messages: [{ role: 'user', content: req.prompt }],
    max_tokens: req.max_tokens,
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeout_ms);

  let resp: Response;
  try {
    resp = await fetch(`${LM_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM request failed: ${msg}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM request failed: HTTP ${resp.status} ${text}`);
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const content = data.choices[0]?.message?.content ?? '';
  return {
    content,
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    duration_ms: Date.now() - start,
  };
};
