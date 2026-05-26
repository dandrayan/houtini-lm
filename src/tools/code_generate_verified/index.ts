import { runCodeGenLoop } from './orchestrator.js';
import { atheneLlmClient } from './llm_client.js';
import type { CodeGenRequest, ModelAlias } from './types.js';

function allowedRootsFromEnv(): string[] {
  const raw = process.env['HOUTINI_LM_ALLOWED_PROJECT_ROOTS'] ?? '';
  return raw.split(':').map((r) => r.trim()).filter(Boolean);
}

export const toolDefinition = {
  name: 'code_generate_verified',
  description:
    'Generate boilerplate code via a local LLM, then automatically compile it in the project and feed errors back for self-correction.\n\n' +
    'ONLY for generic non-domain code — DTOs, records, simple CRUD repository methods, test scaffolds, mapper classes, configuration POCOs, extension methods wrapping a single known API.\n\n' +
    'DO NOT use for: code calling specific library APIs the LLM may not know well (OpenIddict, MediatR, custom frameworks), business logic, domain decisions, cross-file refactoring, auth/crypto/security, or anything where "approximately right" is not acceptable.\n\n' +
    'Pre-flight check before calling:\n' +
    '1. Would verifying the output require the same source/doc lookups as writing from scratch? YES → write directly.\n' +
    '2. Does the task call APIs from a library the LLM may not know? YES → write directly.\n' +
    '3. Is this repetitive/generic enough that there is a standard pattern the LLM has seen many times? NO → write directly.\n\n' +
    'Supported models: qwen3-coder-next (default, best compile rate), gemma4-26b (small tasks), qwen3.6-mtp (not recommended for generation).\n\n' +
    'The tool runs compile-fix iterations automatically (up to max_iterations). Full iteration history and timing are returned in the result.',
  inputSchema: {
    type: 'object' as const,
    required: ['task', 'target_file', 'build_command', 'working_dir'],
    properties: {
      task: {
        type: 'string',
        description: 'Concise description of what code to generate. Must be specific and bounded. Good: "create a UserCreateRequest record with Email (string), Password (string), FirstName (string) properties". Bad: "implement the user feature".',
      },
      model: {
        type: 'string',
        description: 'Model alias: "qwen3-coder-next" (default), "gemma4-26b", or "qwen3.6-mtp". qwen3-coder-next is best for compile-checked boilerplate.',
      },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute paths to existing files the LLM should see as context (interfaces, base classes, related types). Keep under 10 files. Caller is responsible for choosing relevant files — no auto-discovery.',
      },
      target_file: {
        type: 'string',
        description: 'Absolute path where generated code is written. Must be within working_dir.',
      },
      target_file_action: {
        type: 'string',
        description: 'create (default, file must not exist) | replace (overwrite) | append (add to end) | insert_at_marker (insert below a specific line).',
      },
      insert_marker: {
        type: 'string',
        description: 'Required when target_file_action is insert_at_marker. Exact text of the line to find; code is inserted on the line below.',
      },
      build_command: {
        type: 'string',
        description: 'Shell command to verify the code compiles. Examples: "dotnet build MyProject/MyProject.csproj", "npx tsc --noEmit". Use {target_file} as a placeholder if the command needs the file path. No shell metacharacters (&&, |, ;, etc.).',
      },
      test_command: {
        type: 'string',
        description: 'Optional. Shell command to run tests after a successful build. Both build and tests must pass for success.',
      },
      working_dir: {
        type: 'string',
        description: 'Absolute path — the directory build_command and test_command run from. Must be under HOUTINI_LM_ALLOWED_PROJECT_ROOTS.',
      },
      constraints: {
        type: 'string',
        description: 'Free-form constraints appended to the LLM prompt. E.g. "Use file-scoped namespace. No XML doc comments. Follow existing code style."',
      },
      length_cap_tokens: {
        type: 'number',
        description: 'Maximum LLM output tokens (default 1200). Outputs over 1500 tokens have higher error rates.',
      },
      max_iterations: {
        type: 'number',
        description: 'Maximum compile-fix iterations (default 3, max 5). If it fails in 3, it usually fails in 10.',
      },
      timeout_per_iteration_seconds: {
        type: 'number',
        description: 'Per-iteration timeout covering LLM call + build + optional test (default 90s, max 300s).',
      },
    },
  },
};

export async function handleCodeGenerateVerified(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const req: CodeGenRequest = {
    task: args['task'] as string,
    model: (args['model'] as ModelAlias | undefined),
    context_files: args['context_files'] as string[] | undefined,
    target_file: args['target_file'] as string,
    target_file_action: args['target_file_action'] as CodeGenRequest['target_file_action'],
    insert_marker: args['insert_marker'] as string | undefined,
    build_command: args['build_command'] as string,
    test_command: args['test_command'] as string | undefined,
    working_dir: args['working_dir'] as string,
    constraints: args['constraints'] as string | undefined,
    length_cap_tokens: args['length_cap_tokens'] as number | undefined,
    max_iterations: Math.min(args['max_iterations'] as number ?? 3, 5),
    timeout_per_iteration_seconds: Math.min(args['timeout_per_iteration_seconds'] as number ?? 90, 300),
  };

  const result = await runCodeGenLoop(req, allowedRootsFromEnv(), atheneLlmClient);

  const text = JSON.stringify(result, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: !result.success,
  };
}
