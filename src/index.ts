#!/usr/bin/env node
/**
 * Houtini LM — MCP Server for Local LLMs via OpenAI-compatible API
 *
 * Connects to LM Studio (or any OpenAI-compatible endpoint) and exposes
 * chat, custom prompts, code tasks, and model discovery as MCP tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { profileModelsAtStartup, getAllPerformance } from './model-cache.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { toolDefinition as codeGenVerifiedTool, handleCodeGenerateVerified } from './tools/code_generate_verified/index.js';

import {
  LM_BASE_URL, DEFAULT_MAX_TOKENS, INFERENCE_CONNECT_TIMEOUT_MS,
  SKIP_PREFLIGHT_GLOBAL, PREFILL_REFUSE_THRESHOLD_SEC, PREFILL_WARN_THRESHOLD_SEC,
} from './config.js';
import type { ChatMessage, ResponseFormat } from './types.js';
import { session, lifetime, hydrateLifetimeFromDb, getLifetimeModelStats, sessionSummary } from './session.js';
import { getBackend, withInferenceLock, apiHeaders, fetchWithTimeout } from './provider.js';
import {
  listModelsRaw, getContextLength, formatModelDetail, getModelProfileAsync,
  routeToModel, estimatePrefill,
} from './models.js';
import { chatCompletionStreaming, setNotifyFn } from './inference.js';
import { formatFooter } from './footer.js';

// ── MCP Tool definitions ─────────────────────────────────────────────

const TOOLS = [
  codeGenVerifiedTool,
  {
    name: 'chat',
    description:
      'Send a task to a local LLM — a sidekick running on the user\'s hardware or a configured OpenAI-compatible endpoint. ' +
      'It does not consume the user\'s Claude quota. Trades latency for tokens: local inference is typically 3-30× slower than frontier models, so delegation wins when the task is bounded and self-contained.\n\n' +
      'Good fit:\n' +
      '• Explain or summarise code/docs you already have in context\n' +
      '• Generate boilerplate, test stubs, type definitions, mock data\n' +
      '• Answer factual questions about languages, frameworks, APIs\n' +
      '• Draft commit messages, PR descriptions, comments\n' +
      '• Translate or reformat content (JSON↔YAML, snake_case↔camelCase)\n' +
      '• Brainstorm approaches before committing to one\n\n' +
      'Less good when: the task needs tool access, depends on multi-file context you have not captured, or is quick enough for you to answer directly before the round-trip completes.\n\n' +
      'Prompt tips (local models take instructions literally):\n' +
      '(1) Send COMPLETE context — the local LLM cannot read files.\n' +
      '(2) Be explicit about output format ("respond as a JSON array", "return only the function").\n' +
      '(3) Specific system persona beats generic — "Senior TypeScript dev" not "helpful assistant".\n' +
      '(4) State constraints — "no preamble", "reference line numbers", "max 5 bullets".\n\n' +
      'Routing picks the best loaded model automatically. Call `discover` to see what is loaded and, after the first real call, its measured speed. The footer shows cumulative tokens kept in the user\'s quota.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The task. Be specific about expected output format. Include COMPLETE code/context — never truncate.',
        },
        system: {
          type: 'string',
          description: 'Persona for the local LLM. Be specific: "Senior TypeScript dev" not "helpful assistant".',
        },
        temperature: {
          type: 'number',
          description: '0.1 for factual/code, 0.3 for analysis (default), 0.7 for creative. Stay under 0.5 for code.',
        },
        max_tokens: {
          type: 'number',
          description: 'Max response tokens. Defaults to 25% of the loaded model\'s context window (fallback 16,384). Pass a number to cap it tighter for quick answers.',
        },
        json_schema: {
          type: 'object',
          description: 'Force structured JSON output. Provide a JSON Schema object and the response will be guaranteed valid JSON conforming to it. Example: {"name":"result","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id (e.g. "nvidia/nemotron-3-nano-30b-a3b:free" on OpenRouter, "qwen.qwen3-coder-30b-a3b-instruct" on LM Studio). When set, overrides automatic routing. Useful on providers with many models where auto-routing picks poorly.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths whose contents are appended to the message before sending. Files are concatenated with `=== filename ===` headers. Relative paths are rejected — always pass absolute. Useful when keeping file source out of the Claude context window matters.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'custom_prompt',
    description:
      'Structured analysis via the local LLM with explicit system/context/instruction separation. ' +
      'The 3-part format prevents context bleed in smaller models — the local LLM acknowledges the context in a fake assistant turn before receiving the instruction.\n\n' +
      'Good fit when prompt structure matters:\n' +
      '• Code review — paste full source, ask for bugs/improvements\n' +
      '• Comparison — paste two implementations, ask which is better and why\n' +
      '• Refactoring suggestions — paste code, ask for a cleaner version\n' +
      '• Content analysis — paste text, ask for structure/tone/issues\n' +
      '• Any task where separating context from instruction improves clarity\n\n' +
      'Field guidance (each has a job — keep them focused):\n' +
      '• system: persona + constraints, under 30 words. "Expert Python developer focused on performance and correctness."\n' +
      '• context: COMPLETE data — full source, full logs, full text. Never truncate.\n' +
      '• instruction: exactly what to produce, under 50 words. Specify format: "Return a JSON array of {line, issue, fix}."\n\n' +
      'Review the output before acting on it — local model capability varies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        system: {
          type: 'string',
          description: 'Persona. Be specific: "Expert Node.js developer focused on error handling and edge cases."',
        },
        context: {
          type: 'string',
          description: 'The COMPLETE data to analyse. Full source code, full logs, full text. NEVER truncate. Provide either context or paths, not both.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to use as context instead of the context field. Files are read and concatenated with `=== filename ===` headers. Relative paths are rejected — always pass absolute. Provide either context or paths, not both.',
        },
        instruction: {
          type: 'string',
          description: 'What to produce. Specify format: "List 3 bugs as bullet points" or "Return a JSON array of {line, issue, fix}".',
        },
        temperature: {
          type: 'number',
          description: '0.1 for bugs/review, 0.3 for analysis (default), 0.5 for suggestions.',
        },
        max_tokens: {
          type: 'number',
          description: 'Max response tokens. Defaults to 25% of the loaded model\'s context window (fallback 16,384).',
        },
        json_schema: {
          type: 'object',
          description: 'Force structured JSON output. Provide a JSON Schema object and the response will be guaranteed valid JSON conforming to it.',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'code_task',
    description:
      'Send a code-specific task to the local LLM, wrapped with an optimised code-review system prompt. Temperature is locked low (0.2 or the routed model\'s hint) for deterministic output.\n\n' +
      'Good fit:\n' +
      '• Explain what a function/class does\n' +
      '• Find bugs or suggest improvements\n' +
      '• Generate unit tests or type definitions for existing code\n' +
      '• Add error handling, logging, or validation\n' +
      '• Convert between languages or patterns\n\n' +
      'For best results:\n' +
      '• Provide COMPLETE source — the local LLM cannot read files.\n' +
      '• Include imports and type definitions so the model has full context.\n' +
      '• Be specific: "Write 3 Jest tests for the error paths in fetchUser" beats "Write tests".\n' +
      '• Set the language field — it shapes the system prompt and improves accuracy.\n\n' +
      'Verify generated code compiles, handles edge cases, and follows project conventions before committing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'COMPLETE source code. Never truncate. Include imports and full function bodies.',
        },
        task: {
          type: 'string',
          description: 'What to do: "Find bugs", "Explain this", "Add error handling to fetchData", "Write tests".',
        },
        language: {
          type: 'string',
          description: 'Programming language: "typescript", "python", "rust", etc.',
        },
        max_tokens: {
          type: 'number',
          description: 'Max response tokens. Defaults to 25% of the loaded model\'s context window (fallback 16,384).',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
      },
      required: ['code', 'task'],
    },
  },
  {
    name: 'code_task_files',
    description:
      'Like code_task, but the local LLM reads files directly from disk — source never passes through the MCP client\'s context window. Use when reviewing multiple files or a single large file.\n\n' +
      'How it works:\n' +
      '• Provide absolute paths. Relative paths are rejected.\n' +
      '• Files are read in parallel (Promise.allSettled) — one unreadable file does not sink the call.\n' +
      '• Files are concatenated with `=== filename ===` headers and sent to the same code-review pipeline as code_task.\n' +
      '• Read failures are surfaced inline with the reason so the LLM can still reason about the rest.\n' +
      '• Pre-flight prefill estimate: if measured per-model data shows the input would exceed the MCP client\'s ~60s request timeout during prompt processing, the call is refused early with a diagnostic instead of hanging. Split or trim when this fires.\n\n' +
      'Good fit:\n' +
      '• Reviewing related files together (module + its tests, client + server pair)\n' +
      '• Auditing a single large file too big to paste comfortably\n' +
      '• Any code_task where keeping source out of the Claude context window matters\n\n' +
      'Size guidance: on slow hardware (< 25 tok/s generation), keep total input under ~8,000 tokens (~32,000 chars) to stay safely under the client timeout. Faster hardware handles much more — the pre-flight estimator adapts once you\'ve done a few calls and real per-model timings are in the SQLite cache.\n\n' +
      'Same review discipline as code_task — verify the output before acting on it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to analyse. Relative paths are rejected — always pass absolute.',
        },
        task: {
          type: 'string',
          description: 'What to do: "Find bugs", "Explain this module", "Suggest a cleaner API", etc.',
        },
        language: {
          type: 'string',
          description: 'Optional language hint: "typescript", "python", etc. Shapes the system prompt.',
        },
        max_tokens: {
          type: 'number',
          description: 'Optional output budget override. Defaults to 25% of the loaded model\'s context window.',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
        skip_preflight: {
          type: 'boolean',
          description: 'Skip the pre-flight prefill estimate check. Use when the estimator is being overly conservative due to stale cache data from a prior slow call. Also controllable server-wide via the HOUTINI_LM_SKIP_PREFLIGHT=1 env var.',
        },
      },
      required: ['paths', 'task'],
    },
  },
  {
    name: 'discover',
    description:
      'Check whether the local LLM is online and what model is loaded. Returns model name, context window size, ' +
      'response latency, and cumulative session stats (tokens offloaded so far). ' +
      'Call this if you are unsure whether the local LLM is available before delegating work. ' +
      'Fast — typically responds in under 1 second, or returns an offline status within 5 seconds if the host is unreachable.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_models',
    description:
      'List all models on the local LLM server — both loaded (ready) and available (downloaded but not active). ' +
      'Shows rich metadata for each model: type (llm/vlm/embeddings), architecture, quantization, context window, ' +
      'and a capability profile describing what the model is best at. ' +
      'Use this to understand which models are available and suggest switching when a different model would suit the task better.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'embed',
    description:
      'Generate text embeddings via the local LLM server. Requires an embedding model to be loaded ' +
      '(e.g. Nomic Embed). Returns a vector representation of the input text for semantic search, ' +
      'similarity comparison, or RAG pipelines. Uses the OpenAI-compatible /v1/embeddings endpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: {
          type: 'string',
          description: 'The text to embed. Can be a single string.',
        },
        model: {
          type: 'string',
          description: 'Embedding model ID. If omitted, uses whatever embedding model is loaded.',
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'stats',
    description:
      'Show user stats: tokens offloaded, calls made, per-model performance — for the current session AND ' +
      'lifetime (persisted in SQLite at ~/.houtini-lm/model-cache.db). Unlike `discover` which includes the ' +
      'model catalog, `stats` returns just the numbers in a compact markdown table — cheap to call repeatedly ' +
      'to see the 💰 Claude-quota savings counter climb. Useful for quantifying how much work the local model ' +
      'is genuinely doing, and for noticing when a model\'s reasoning-token ratio is drifting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Optional: filter output to a single model ID. Omit to see all models this workstation has used.',
        },
      },
    },
  },
];

// ── MCP Server ───────────────────────────────────────────────────────

const SIDEKICK_INSTRUCTIONS =
  `Houtini-lm is a local LLM sidekick. It runs on the user's hardware (or a configured OpenAI-compatible endpoint) and handles bounded work without consuming the user's Claude quota.\n\n` +
  `When to reach for it: bounded, self-contained tasks you can describe in one message — explanations, boilerplate, test stubs, code review of pasted or file-loaded source, translations, commit messages, format conversion, brainstorming. Trades wall-clock time for tokens (typically 3-30× slower than frontier models).\n\n` +
  `When not to: tasks that need tool access, cross-file reasoning you haven't captured, or work fast enough to answer directly before the delegation round-trip completes.\n\n` +
  `Call \`discover\` in delegation-heavy sessions to see what model is loaded, its capability profile, and — after the first real call — its measured speed. The response footer reports cumulative tokens kept in the user's quota.`;

const server = new Server(
  { name: 'houtini-lm', version: '2.13.2' },
  { capabilities: { tools: {}, resources: {} }, instructions: SIDEKICK_INSTRUCTIONS },
);

// ── MCP Resources ─────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'houtini://metrics/session',
      name: 'Session Offload Metrics',
      description: 'Cumulative token offload stats, per-model performance, and quality signals for the current session.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'houtini://metrics/session') {
    const modelStats: Record<string, { calls: number; avgTtftMs: number; avgTokPerSec: number | null }> = {};
    for (const [modelId, stats] of session.modelStats) {
      modelStats[modelId] = {
        calls: stats.calls,
        avgTtftMs: stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0,
        avgTokPerSec: stats.perfCalls > 0 ? parseFloat((stats.totalTokPerSec / stats.perfCalls).toFixed(1)) : null,
      };
    }

    const metrics = {
      session: {
        totalCalls: session.calls,
        promptTokens: session.promptTokens,
        completionTokens: session.completionTokens,
        totalTokensOffloaded: session.promptTokens + session.completionTokens,
      },
      perModel: modelStats,
      endpoint: LM_BASE_URL,
    };

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(metrics, null, 2),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

type LoadFilesOk = { ok: true; combined: string; successCount: number; totalCount: number };
type LoadFilesErr = { ok: false; content: [{ type: 'text'; text: string }]; isError: true };

async function loadFiles(paths: string[]): Promise<LoadFilesOk | LoadFilesErr> {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, isError: true, content: [{ type: 'text', text: 'Error: paths must be a non-empty array of absolute file paths.' }] };
  }
  const relative = paths.filter((p) => typeof p !== 'string' || !isAbsolute(p));
  if (relative.length > 0) {
    return { ok: false, isError: true, content: [{ type: 'text', text: `Error: all paths must be absolute. Relative paths: ${JSON.stringify(relative)}` }] };
  }
  const reads = await Promise.allSettled(
    paths.map(async (p) => ({ path: p, content: await readFile(p, 'utf8') })),
  );
  const sections: string[] = [];
  let successCount = 0;
  reads.forEach((r, i) => {
    const p = paths[i];
    if (r.status === 'fulfilled') {
      successCount++;
      sections.push(`=== ${basename(p)} (${p}) ===\n${r.value.content}`);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      sections.push(`=== ${basename(p)} (${p}) — READ FAILED ===\n[Could not read: ${reason}]`);
    }
  });
  if (successCount === 0) {
    return { ok: false, isError: true, content: [{ type: 'text', text: `Error: none of the ${paths.length} file(s) could be read. Check the paths and permissions.\n\n${sections.join('\n\n')}` }] };
  }
  return { ok: true, combined: sections.join('\n\n'), successCount, totalCount: paths.length };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const progressToken = request.params._meta?.progressToken;

  try {
    switch (name) {
      case 'chat': {
        const { message, system, temperature, max_tokens, json_schema, model, paths } = args as {
          message: string;
          system?: string;
          temperature?: number;
          max_tokens?: number;
          json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
          model?: string;
          paths?: string[];
        };

        let finalMessage = message;
        if (paths && paths.length > 0) {
          const loaded = await loadFiles(paths);
          if (!loaded.ok) return { content: loaded.content, isError: loaded.isError };
          finalMessage = `${message}\n\n${loaded.combined}`;
        }

        const route = await routeToModel('chat', model);
        const messages: ChatMessage[] = [];
        const systemContent = system
          ? (route.hints.outputConstraint ? `${system}\n\n${route.hints.outputConstraint}` : system)
          : (route.hints.outputConstraint || undefined);
        if (systemContent) messages.push({ role: 'system', content: systemContent });
        messages.push({ role: 'user', content: finalMessage });

        const responseFormat: ResponseFormat | undefined = json_schema
          ? { type: 'json_schema', json_schema: { name: json_schema.name, strict: json_schema.strict ?? true, schema: json_schema.schema } }
          : undefined;

        const resp = await chatCompletionStreaming(messages, {
          temperature: temperature ?? route.hints.chatTemp,
          maxTokens: max_tokens,
          model: route.modelId,
          responseFormat,
          progressToken,
        });

        const footer = formatFooter(resp);
        return { content: [{ type: 'text', text: resp.content + footer }] };
      }

      case 'custom_prompt': {
        const { system, context, paths, instruction, temperature, max_tokens, json_schema, model } = args as {
          system?: string;
          context?: string;
          paths?: string[];
          instruction: string;
          temperature?: number;
          max_tokens?: number;
          json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
          model?: string;
        };

        if (context && paths && paths.length > 0) {
          return { content: [{ type: 'text', text: 'Error: provide either context or paths, not both.' }], isError: true };
        }

        let resolvedContext = context;
        if (paths && paths.length > 0) {
          const loaded = await loadFiles(paths);
          if (!loaded.ok) return { content: loaded.content, isError: loaded.isError };
          resolvedContext = loaded.combined;
        }

        const route = await routeToModel('analysis', model);
        const messages: ChatMessage[] = [];
        const systemContent = system
          ? (route.hints.outputConstraint ? `${system}\n\n${route.hints.outputConstraint}` : system)
          : (route.hints.outputConstraint || undefined);
        if (systemContent) messages.push({ role: 'system', content: systemContent });

        // Multi-turn format prevents context bleed in smaller models.
        if (resolvedContext) {
          messages.push({ role: 'user', content: `Here is the context for analysis:\n\n${resolvedContext}` });
          messages.push({ role: 'assistant', content: 'Understood. I have read the full context. What would you like me to do with it?' });
        }
        messages.push({ role: 'user', content: instruction });

        const responseFormat: ResponseFormat | undefined = json_schema
          ? { type: 'json_schema', json_schema: { name: json_schema.name, strict: json_schema.strict ?? true, schema: json_schema.schema } }
          : undefined;

        const resp = await chatCompletionStreaming(messages, {
          temperature: temperature ?? route.hints.chatTemp,
          maxTokens: max_tokens,
          model: route.modelId,
          responseFormat,
          progressToken,
        });

        const footer = formatFooter(resp);
        return {
          content: [{ type: 'text', text: resp.content + footer }],
        };
      }

      case 'code_task': {
        const { code, task, language, max_tokens: codeMaxTokens, model } = args as {
          code: string;
          task: string;
          language?: string;
          max_tokens?: number;
          model?: string;
        };

        const lang = language || 'unknown';
        const route = await routeToModel('code', model);
        const outputConstraint = route.hints.outputConstraint
          ? ` ${route.hints.outputConstraint}`
          : '';

        const codeMessages: ChatMessage[] = [
          {
            role: 'system',
            content: `Expert ${lang} developer. Your task: ${task}\n\nBe specific — reference line numbers, function names, and concrete fixes. Output your analysis as a markdown list.${outputConstraint}`,
          },
          {
            role: 'user',
            content: `\`\`\`${lang}\n${code}\n\`\`\``,
          },
        ];

        const codeResp = await chatCompletionStreaming(codeMessages, {
          temperature: route.hints.codeTemp,
          maxTokens: codeMaxTokens ?? DEFAULT_MAX_TOKENS,
          model: route.modelId,
          progressToken,
        });

        const codeFooter = formatFooter(codeResp, lang);
        const suggestionLine = route.suggestion ? `\n${route.suggestion}` : '';
        return { content: [{ type: 'text', text: codeResp.content + codeFooter + suggestionLine }] };
      }

      case 'code_task_files': {
        const { paths, task, language, max_tokens: codeMaxTokens, model, skip_preflight } = args as {
          paths: string[];
          task: string;
          language?: string;
          max_tokens?: number;
          model?: string;
          skip_preflight?: boolean;
        };

        const loaded = await loadFiles(paths);
        if (!loaded.ok) return { content: loaded.content, isError: loaded.isError };
        const { combined, successCount } = loaded;

        const lang = language || 'unknown';
        const route = await routeToModel('code', model);
        const outputConstraint = route.hints.outputConstraint
          ? ` ${route.hints.outputConstraint}`
          : '';

        const skipPreflight = SKIP_PREFLIGHT_GLOBAL || skip_preflight === true;
        const estimate = skipPreflight ? null : await estimatePrefill(combined.length, route.modelId);
        const forceRefuse = !skipPreflight && PREFILL_REFUSE_THRESHOLD_SEC === 0;
        const isConfidentEstimate = estimate !== null && (estimate.basis === 'linear-fit' || estimate.basis === 'ratio');
        if (forceRefuse || (isConfidentEstimate && estimate!.estimatedSeconds > PREFILL_REFUSE_THRESHOLD_SEC)) {
          const est = estimate!;
          const estSec = forceRefuse ? 0 : Math.round(est.estimatedSeconds);
          const basisLine = forceRefuse
            ? `• Estimator: bypassed (HOUTINI_LM_PREFILL_THRESHOLD_SEC=0)`
            : est.basis === 'linear-fit'
              ? `• Estimator: linear fit — TTFT ≈ ${Math.round(est.fit!.alphaMs)}ms + ${est.fit!.betaMsPerToken.toFixed(2)}ms/token (n=${est.fit!.n}, R²=${est.fit!.r2.toFixed(2)})`
              : `• Estimator: ratio fallback — ~${Math.round(est.prefillTokPerSec!)} tok/s (from ${getLifetimeModelStats(route.modelId)?.ttftCalls ?? 0} prior calls; less accurate for inputs far from the historical mean)`;
          const inputLine = forceRefuse
            ? `• Input size: ~${Math.ceil(combined.length / 4).toLocaleString()} tokens across ${successCount} file(s)`
            : `• Input size: ~${est.inputTokens.toLocaleString()} tokens across ${successCount} file(s)`;
          return {
            content: [{
              type: 'text',
              text:
                `Error: estimated prefill time exceeds the ~60s MCP client timeout.\n\n` +
                `${inputLine}\n` +
                `${basisLine}\n` +
                `• Estimated prefill: ~${estSec}s (threshold: ${PREFILL_REFUSE_THRESHOLD_SEC}s)\n\n` +
                `Options: split the files into smaller groups, trim the largest file, or use \`code_task\` with a focused excerpt. ` +
                `To override the estimator, pass skip_preflight: true or set HOUTINI_LM_SKIP_PREFLIGHT=1.`,
            }],
            isError: true,
          };
        }
        if (estimate !== null && estimate.estimatedSeconds > PREFILL_WARN_THRESHOLD_SEC) {
          const basisDetail = estimate.basis === 'linear-fit'
            ? `linear-fit n=${estimate.fit!.n} R²=${estimate.fit!.r2.toFixed(2)}`
            : estimate.basis;
          process.stderr.write(
            `[houtini-lm] Large input warning: ~${estimate.inputTokens} tokens, est prefill ~${Math.round(estimate.estimatedSeconds)}s (${basisDetail}). Proceeding.\n`,
          );
        }

        const codeMessages: ChatMessage[] = [
          {
            role: 'system',
            content: `Expert ${lang} developer. Your task: ${task}\n\nThe user has provided ${paths.length} file(s), concatenated below with \`=== filename ===\` headers. Reference files by name in your output. Be specific — line numbers, function names, concrete fixes. Output your analysis as a markdown list.${outputConstraint}`,
          },
          {
            role: 'user',
            content: `\`\`\`${lang}\n${combined}\n\`\`\``,
          },
        ];

        const codeResp = await chatCompletionStreaming(codeMessages, {
          temperature: route.hints.codeTemp,
          maxTokens: codeMaxTokens,
          model: route.modelId,
          progressToken,
        });

        const readSummary = successCount === paths.length
          ? `${paths.length} file(s) read`
          : `${successCount}/${paths.length} file(s) read`;
        const codeFooter = formatFooter(codeResp, `${lang} · ${readSummary}`);
        const suggestionLine = route.suggestion ? `\n${route.suggestion}` : '';
        return { content: [{ type: 'text', text: codeResp.content + codeFooter + suggestionLine }] };
      }

      case 'discover': {
        const start = Date.now();
        let models: Awaited<ReturnType<typeof listModelsRaw>>;
        try {
          models = await listModelsRaw();
        } catch (err) {
          const ms = Date.now() - start;
          const reason = err instanceof Error && err.name === 'AbortError'
            ? `Host unreachable (timed out after ${ms}ms)`
            : `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
          return {
            content: [{
              type: 'text',
              text: `Status: OFFLINE\nEndpoint: ${LM_BASE_URL}\n${reason}\n\nThe local LLM is not available right now. Do not attempt to delegate tasks to it.`,
            }],
          };
        }
        const ms = Date.now() - start;

        if (models.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `Status: ONLINE (no model loaded)\nEndpoint: ${LM_BASE_URL}\nLatency: ${ms}ms\n\nThe server is running but no model is loaded. Ask the user to load a model in LM Studio.`,
            }],
          };
        }

        const loadedModels = models.filter((m) => m.state === 'loaded' || !m.state);
        const availableModels = models.filter((m) => m.state === 'not-loaded');

        const primary = loadedModels[0] || models[0];
        const ctx = getContextLength(primary);
        const primaryProfile = await getModelProfileAsync(primary);

        const summary = sessionSummary();
        const sessionStats = session.calls > 0 || lifetime.totalCalls > 0
          ? `\n${summary}`
          : `\n💰 Claude quota saved this session: 0 tokens — no calls yet. Measured speed for each model will appear here after the first real call.`;

        const primaryStats = session.modelStats.get(primary.id);
        const primaryLifetime = lifetime.modelStats.get(primary.id);
        let speedLine = '';
        if (primaryStats && primaryStats.perfCalls > 0) {
          const avgTtft = primaryStats.ttftCalls > 0 ? Math.round(primaryStats.totalTtftMs / primaryStats.ttftCalls) : 0;
          const avgTokSec = (primaryStats.totalTokPerSec / primaryStats.perfCalls).toFixed(1);
          speedLine = `Measured speed (session): ${avgTokSec} tok/s · TTFT ${avgTtft}ms (${primaryStats.perfCalls} call${primaryStats.perfCalls === 1 ? '' : 's'})\n`;
          if (primaryLifetime && primaryLifetime.perfCalls > primaryStats.perfCalls) {
            const lAvgTtft = primaryLifetime.ttftCalls > 0 ? Math.round(primaryLifetime.totalTtftMs / primaryLifetime.ttftCalls) : 0;
            const lAvgTokSec = (primaryLifetime.totalTokPerSec / primaryLifetime.perfCalls).toFixed(1);
            speedLine += `Measured speed (lifetime on this workstation): ${lAvgTokSec} tok/s · TTFT ${lAvgTtft}ms (${primaryLifetime.perfCalls} calls)\n`;
          }
        } else if (primaryLifetime && primaryLifetime.perfCalls > 0) {
          const lAvgTtft = primaryLifetime.ttftCalls > 0 ? Math.round(primaryLifetime.totalTtftMs / primaryLifetime.ttftCalls) : 0;
          const lAvgTokSec = (primaryLifetime.totalTokPerSec / primaryLifetime.perfCalls).toFixed(1);
          speedLine = `Measured speed (lifetime on this workstation): ${lAvgTokSec} tok/s · TTFT ${lAvgTtft}ms (${primaryLifetime.perfCalls} calls, last used ${new Date(primaryLifetime.lastUsedAt).toISOString().slice(0, 10)})\n`;
        } else {
          speedLine = `Measured speed: not yet benchmarked — will be captured on the first real call.\n`;
        }

        const backendLabel = getBackend() === 'lmstudio' ? 'LM Studio'
          : getBackend() === 'ollama' ? 'Ollama'
          : 'OpenAI-compatible';

        let text =
          `Status: ONLINE\n` +
          `Endpoint: ${LM_BASE_URL} (${backendLabel})\n` +
          `Connection latency: ${ms}ms (does not reflect inference speed)\n` +
          `Active model: ${primary.id}\n` +
          `Context window: ${ctx.toLocaleString()} tokens\n` +
          speedLine;

        if (primaryProfile) {
          text += `Family: ${primaryProfile.family}\n`;
          text += `Description: ${primaryProfile.description}\n`;
          text += `Best for: ${primaryProfile.bestFor.join(', ')}\n`;
          text += `Strengths: ${primaryProfile.strengths.join(', ')}\n`;
          if (primaryProfile.weaknesses.length > 0) {
            text += `Weaknesses: ${primaryProfile.weaknesses.join(', ')}\n`;
          }
        }

        if (loadedModels.length > 0) {
          text += `\nLoaded models (● ready to use):\n`;
          text += (await Promise.all(loadedModels.map((m) => formatModelDetail(m)))).join('\n\n');
        }

        if (availableModels.length > 0) {
          text += `\n\nAvailable models (○ downloaded, not loaded — can be activated in LM Studio):\n`;
          text += (await Promise.all(availableModels.map((m) => formatModelDetail(m)))).join('\n\n');
        }

        if (session.modelStats.size > 0) {
          text += `\n\nPerformance (this session):\n`;
          for (const [modelId, stats] of session.modelStats) {
            const avgTtft = stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0;
            const avgTokSec = stats.perfCalls > 0 ? (stats.totalTokPerSec / stats.perfCalls).toFixed(1) : '?';
            text += `  ${modelId}: ${stats.calls} calls, avg TTFT ${avgTtft}ms, avg ${avgTokSec} tok/s\n`;
          }
        }

        const hasLifetimeBeyondSession = Array.from(lifetime.modelStats.entries())
          .some(([id, l]) => l.calls > (session.modelStats.get(id)?.calls ?? 0));
        if (hasLifetimeBeyondSession) {
          text += `\nPerformance (lifetime on this workstation):\n`;
          for (const [modelId, stats] of lifetime.modelStats) {
            const avgTtft = stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0;
            const avgTokSec = stats.perfCalls > 0 ? (stats.totalTokPerSec / stats.perfCalls).toFixed(1) : '?';
            const lastUsed = new Date(stats.lastUsedAt).toISOString().slice(0, 10);
            text += `  ${modelId}: ${stats.calls} calls, avg TTFT ${avgTtft}ms, avg ${avgTokSec} tok/s (last used ${lastUsed})\n`;
          }
        }

        text += `${sessionStats}\n\n`;
        text += `The local LLM is available. You can delegate tasks using chat, custom_prompt, code_task, code_task_files, or embed.`;

        return { content: [{ type: 'text', text }] };
      }

      case 'list_models': {
        const models = await listModelsRaw();
        if (!models.length) {
          return { content: [{ type: 'text', text: 'No models currently loaded or available.' }] };
        }

        const loadedModels = models.filter((m) => m.state === 'loaded' || !m.state);
        const availableModels = models.filter((m) => m.state === 'not-loaded');

        let text = '';

        if (loadedModels.length > 0) {
          text += `Loaded models (● ready to use):\n\n`;
          text += (await Promise.all(loadedModels.map((m) => formatModelDetail(m, true)))).join('\n\n');
        }

        if (availableModels.length > 0) {
          if (text) text += '\n\n';
          text += `Available models (○ downloaded, not loaded):\n\n`;
          text += (await Promise.all(availableModels.map((m) => formatModelDetail(m, true)))).join('\n\n');
        }

        return { content: [{ type: 'text', text }] };
      }

      case 'embed': {
        const { input, model: embedModel } = args as { input: string; model?: string };

        return await withInferenceLock(async () => {
          const embedBody: Record<string, unknown> = { input };
          if (embedModel) {
            embedBody.model = embedModel;
          }

          const res = await fetchWithTimeout(
            `${LM_BASE_URL}/v1/embeddings`,
            { method: 'POST', headers: apiHeaders(), body: JSON.stringify(embedBody) },
            INFERENCE_CONNECT_TIMEOUT_MS,
          );

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Embeddings API error ${res.status}: ${errText}`);
          }

          const data = (await res.json()) as {
            data: { embedding: number[]; index: number }[];
            model: string;
            usage?: { prompt_tokens: number; total_tokens: number };
          };

          const embedding = data.data[0]?.embedding;
          if (!embedding) throw new Error('No embedding returned');

          const usageInfo = data.usage
            ? `${data.usage.prompt_tokens} tokens embedded`
            : '';

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                model: data.model,
                dimensions: embedding.length,
                embedding,
                usage: usageInfo,
              }),
            }],
          };
        });
      }

      case 'stats': {
        const { model: filterModel } = args as { model?: string };

        const backendLabel = getBackend() === 'lmstudio' ? 'LM Studio'
          : getBackend() === 'ollama' ? 'Ollama'
          : 'OpenAI-compatible';

        const lines: string[] = [];
        lines.push(`## Houtini LM stats`);
        lines.push('');
        lines.push(`**Endpoint**: ${LM_BASE_URL} (${backendLabel})`);
        if (lifetime.firstSeenAt) {
          lines.push(`**First call on this workstation**: ${new Date(lifetime.firstSeenAt).toISOString().slice(0, 10)}`);
        }
        lines.push('');

        lines.push(`### Totals`);
        lines.push('');
        lines.push(`| Scope    | Calls | Prompt tokens | Completion tokens | Total tokens |`);
        lines.push(`|----------|------:|--------------:|------------------:|-------------:|`);
        lines.push(`| Session  | ${session.calls} | ${session.promptTokens.toLocaleString()} | ${session.completionTokens.toLocaleString()} | ${(session.promptTokens + session.completionTokens).toLocaleString()} |`);
        lines.push(`| Lifetime | ${lifetime.totalCalls} | — | — | ${lifetime.totalTokens.toLocaleString()} |`);
        lines.push('');

        const modelIds = new Set<string>([
          ...session.modelStats.keys(),
          ...lifetime.modelStats.keys(),
        ]);
        const filtered = filterModel ? [...modelIds].filter((m) => m === filterModel) : [...modelIds];

        if (filtered.length > 0) {
          lines.push(`### Per-model performance`);
          lines.push('');
          lines.push(`| Model | Scope | Calls | Avg TTFT (ms) | Avg tok/s | Prompt tokens | Last used |`);
          lines.push(`|-------|-------|------:|--------------:|----------:|--------------:|-----------|`);
          for (const modelId of filtered.sort()) {
            const s = session.modelStats.get(modelId);
            const l = lifetime.modelStats.get(modelId);
            if (s) {
              const avgTtft = s.ttftCalls > 0 ? Math.round(s.totalTtftMs / s.ttftCalls) : '—';
              const avgTokSec = s.perfCalls > 0 ? (s.totalTokPerSec / s.perfCalls).toFixed(1) : '—';
              lines.push(`| ${modelId} | session | ${s.calls} | ${avgTtft} | ${avgTokSec} | — | — |`);
            }
            if (l) {
              const avgTtft = l.ttftCalls > 0 ? Math.round(l.totalTtftMs / l.ttftCalls) : '—';
              const avgTokSec = l.perfCalls > 0 ? (l.totalTokPerSec / l.perfCalls).toFixed(1) : '—';
              const lastUsed = new Date(l.lastUsedAt).toISOString().slice(0, 10);
              lines.push(`| ${modelId} | lifetime | ${l.calls} | ${avgTtft} | ${avgTokSec} | ${l.totalPromptTokens.toLocaleString()} | ${lastUsed} |`);
            }
          }
          lines.push('');
        } else if (filterModel) {
          lines.push(`No history for model: \`${filterModel}\`. Try \`list_models\` to see what's been used.`);
          lines.push('');
        } else {
          lines.push(`No calls yet — delegate a task via \`chat\`, \`custom_prompt\`, \`code_task\`, or \`code_task_files\` to start building stats.`);
          lines.push('');
        }

        if (!filterModel) {
          try {
            const rows = await getAllPerformance();
            const totalReasoning = rows.reduce((sum, r) => sum + (r.totalReasoningTokens || 0), 0);
            const totalCompletion = rows.reduce((sum, r) => sum + r.totalCompletionTokens, 0);
            if (totalCompletion > 0) {
              const pct = ((totalReasoning / totalCompletion) * 100).toFixed(1);
              lines.push(`### Reasoning-token overhead (lifetime)`);
              lines.push('');
              lines.push(`${totalReasoning.toLocaleString()} / ${totalCompletion.toLocaleString()} completion tokens spent on hidden reasoning (${pct}% of generation budget). ` +
                (parseFloat(pct) > 30
                  ? `**High** — consider loading a non-thinking model, or check that \`reasoning_effort\` is being honoured (see stderr logs).`
                  : parseFloat(pct) > 10
                    ? `Moderate — normal for thinking-model families.`
                    : `Low — reasoning is effectively suppressed.`));
              lines.push('');
            }
          } catch { /* best-effort — don't fail the tool call */ }
        }

        lines.push(`*Stats persist across restarts in \`~/.houtini-lm/model-cache.db\`.*`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'code_generate_verified': {
        return await handleCodeGenerateVerified(args as Record<string, unknown>);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

async function main() {
  // Wire up the progress-notification function now that `server` exists.
  setNotifyFn((params) => server.notification(params));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Houtini LM server running (${LM_BASE_URL})\n`);

  listModelsRaw()
    .then((models) => profileModelsAtStartup(models))
    .catch((err) => process.stderr.write(`[houtini-lm] Startup profiling skipped: ${err}\n`));

  hydrateLifetimeFromDb().catch((err) =>
    process.stderr.write(`[houtini-lm] Lifetime hydration skipped: ${err}\n`),
  );
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
